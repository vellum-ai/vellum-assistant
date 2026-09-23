import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from http.server import BaseHTTPRequestHandler, HTTPServer

from launcher import Service, Supervisor, http_ready
import operate
from operate import completed_reply


class SupervisorTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def service(self, name, code, ready=None):
        return Service(name, [sys.executable, "-u", "-c", code], str(self.root), dict(os.environ),
                       ready or (lambda: (self.root / name).exists()))

    def supervisor(self, specs, startup_timeout=3):
        return Supervisor(specs, startup_timeout=startup_timeout, stop_timeout=0.2,
                          ready_file=self.root / "ready")

    def test_starts_in_readiness_order_and_stops_on_clean_unexpected_exit(self):
        first = self.service("first", "import pathlib,time; time.sleep(.3); pathlib.Path('first').touch(); time.sleep(30)")
        second = self.service("second", "import pathlib,time; assert pathlib.Path('first').exists(); pathlib.Path('second').touch(); time.sleep(.3)")
        supervisor = self.supervisor([first, second])
        self.assertEqual(supervisor.run(), 1)
        self.assertTrue((self.root / "second").exists())
        self.assertFalse((self.root / "ready").exists())
        self.assertTrue(all(child.poll() is not None for _, child in supervisor.children))

    def test_failure_during_startup_prevents_dependent_launch(self):
        supervisor = self.supervisor([
            self.service("first", "raise SystemExit(7)"),
            self.service("second", "import pathlib; pathlib.Path('second').touch()"),
        ])
        self.assertEqual(supervisor.run(), 1)
        self.assertFalse((self.root / "second").exists())

    def test_readiness_timeout_kills_unresponsive_child(self):
        supervisor = self.supervisor([self.service("stuck", "import time; time.sleep(30)")], startup_timeout=.3)
        self.assertEqual(supervisor.run(), 1)
        self.assertIsNotNone(supervisor.children[0][1].poll())

    def test_signal_during_startup_stops_process_group(self):
        code = """
import pathlib, signal, subprocess, sys, time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])
pathlib.Path('child.pid').write_text(str(child.pid))
while True:
    time.sleep(1)
"""
        supervisor = self.supervisor([self.service("parent", code)])
        timer = threading.Timer(.5, lambda: supervisor.signal(signal.SIGTERM, None))
        timer.start()
        try:
            self.assertEqual(supervisor.run(), 0)
        finally:
            timer.join()
        child_pid = int((self.root / "child.pid").read_text())
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            result = subprocess.run(["ps", "-o", "stat=", "-p", str(child_pid)], capture_output=True, text=True)
            if not result.stdout.strip() or result.stdout.strip().startswith("Z"):
                break
            time.sleep(.05)
        else:
            os.kill(child_pid, signal.SIGKILL)
            self.fail("descendant survived supervisor shutdown")
        self.assertEqual(supervisor.children[0][1].returncode, -signal.SIGKILL)

    def test_readiness_waits_for_migrations_even_with_http_200(self):
        payload = {"ready": False}

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps(payload).encode())

            def log_message(self, *_args):
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        try:
            self.assertFalse(http_ready(server.server_port))
            payload["ready"] = True
            self.assertTrue(http_ready(server.server_port))
        finally:
            server.shutdown()
            thread.join()
            server.server_close()


class ProvisioningTests(unittest.TestCase):
    def test_refresh_authenticates_with_existing_access_token_and_saves_rotated_session(self):
        with tempfile.TemporaryDirectory() as directory:
            auth = Path(directory) / "guardian.json"
            auth.write_text(json.dumps({"accessToken": "old-access", "refreshToken": "old-refresh"}))

            def refresh(port, path, body, token=None):
                self.assertEqual((port, path), (7830, "/v1/guardian/refresh"))
                self.assertEqual(token, "old-access")
                self.assertEqual(body["refreshToken"], "old-refresh")
                return {"accessToken": "new-access", "refreshToken": "new-refresh"}

            with patch.object(operate, "AUTH", auth), patch.object(operate, "request", refresh):
                self.assertEqual(operate.guardian(), "new-access")
            self.assertEqual(json.loads(auth.read_text())["refreshToken"], "new-refresh")

    def test_provisioning_orders_url_before_key_and_checks_vault_readback(self):
        with tempfile.TemporaryDirectory() as directory:
            keys = Path(directory) / "keys.json"
            keys.write_text(json.dumps({"CES_SERVICE_TOKEN": "test-service-token"}))
            vault = {}
            writes = []

            def api(port, path, body=None, token=None):
                if port == 7830:
                    self.assertEqual(token, "test-guardian")
                    self.assertEqual(path, "/v1/secrets")
                    vault[body["name"]] = body["value"]
                    writes.append(body["name"])
                    return {"success": True}
                self.assertEqual(token, "test-service-token")
                return {"value": vault[path.removeprefix("/v1/credentials/")]}

            with patch.object(operate, "KEYS", keys), patch.object(operate, "request", api):
                operate.provision("test-guardian", "https://platform.example.com", "test-key")
                self.assertEqual(writes, ["vellum:platform_base_url", "vellum:assistant_api_key"])
                with patch.object(operate, "request", return_value={"success": True, "value": "wrong"}):
                    with self.assertRaisesRegex(RuntimeError, "readback"):
                        operate.provision("test-guardian", "https://platform.example.com", "test-key")


class ChatTests(unittest.TestCase):
    def test_completion_requires_finished_turn_and_rejects_tools_and_provider_errors(self):
        message = {"role": "assistant", "contentBlocks": [{"type": "text", "text": "COMBINED_OK"}]}
        self.assertIsNone(completed_reply({"processing": True, "messages": [message]}))
        self.assertEqual(completed_reply({"processing": False, "messages": [message]}), "COMBINED_OK")
        for extra in ({"providerError": "failed"}, {"toolCalls": [{"name": "terminal"}]},
                      {"contentBlocks": [{"type": "tool_use"}]}):
            with self.assertRaises(RuntimeError):
                completed_reply({"processing": False, "messages": [{**message, **extra}]})


if __name__ == "__main__":
    unittest.main()

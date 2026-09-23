"""Linux process supervisor for the combined sandbox image."""

import argparse
import fcntl
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from dataclasses import dataclass
from collections.abc import Callable

DATA = Path("/mnt/assistant")
RUN = Path("/run/vellum-combined")
READY = RUN / "ready"
KEYS = DATA / "supervisor/keys.json"
PORTS = (8090, 8000, 7830)


def log(message):
    print(f"[supervisor] {message}", flush=True)


def write_private_json(path, value):
    temporary = path.with_suffix(".tmp")
    with temporary.open("w") as output:
        os.chmod(temporary, 0o600)
        json.dump(value, output)
        output.flush()
        os.fsync(output.fileno())
    temporary.replace(path)
    directory = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def http_ready(port):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/readyz", timeout=2) as response:
            body = json.load(response)
            return response.status == 200 and body.get("ready") is not False
    except (OSError, ValueError):
        return False


def tcp_ready(port):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1):
            return True
    except OSError:
        return False


def initialize():
    if not os.path.ismount(DATA):
        raise RuntimeError("Mount one persistent data volume at /mnt/assistant before starting.")
    os.umask(0o077)
    RUN.mkdir(parents=True, exist_ok=True)
    (DATA / "supervisor").mkdir(exist_ok=True)
    lock = (DATA / "supervisor/lock").open("a")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    READY.unlink(missing_ok=True)
    for directory in ("assistant-data", "workspace", "gateway-home", "gateway-security", "ces-data", "ces-security"):
        (DATA / directory).mkdir(exist_ok=True)
    for directory in ("ces-bootstrap", "gateway-ipc", "assistant-ipc"):
        Path("/run", directory).mkdir(exist_ok=True)
    if not KEYS.exists():
        keys = {name: secrets.token_hex(32) for name in (
            "CES_SERVICE_TOKEN", "ACTOR_TOKEN_SIGNING_KEY", "GUARDIAN_BOOTSTRAP_SECRET"
        )}
        write_private_json(KEYS, keys)
    keys = json.loads(KEYS.read_text())
    for name in ("CES_SERVICE_TOKEN", "ACTOR_TOKEN_SIGNING_KEY", "GUARDIAN_BOOTSTRAP_SECRET"):
        if not isinstance(keys.get(name), str) or len(keys[name]) < 32:
            raise RuntimeError(f"Invalid persisted {name}; restore the supervisor keys from backup.")
    config = DATA / "workspace/config.json"
    try:
        with config.open("x") as output:
            json.dump({"gateway": {"unmappedPolicy": "default", "defaultAssistantId": "self"}}, output)
    except FileExistsError:
        pass
    return lock, keys


@dataclass
class Service:
    name: str
    command: list[str]
    cwd: str
    env: dict[str, str]
    ready: Callable[[], bool]


def services(keys, blaxel):
    common = {key: os.environ[key] for key in (
        "LANG", "LC_ALL", "TZ", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
        "VELLUM_PLATFORM_URL", "PLATFORM_ASSISTANT_ID",
    ) if key in os.environ}
    common.update({
        "PATH": "/data/.bun/bin:/data/.python/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "IS_PLATFORM": "1", "IS_CONTAINERIZED": "true", "VELLUM_WORKSPACE_DIR": "/workspace",
        "CES_SERVICE_TOKEN": keys["CES_SERVICE_TOKEN"], "CES_CREDENTIAL_URL": "http://127.0.0.1:8090",
        "CES_BOOTSTRAP_SOCKET_DIR": "/run/ces-bootstrap", "CES_MANAGED_MODE": "1",
        "GATEWAY_IPC_SOCKET_DIR": "/run/gateway-ipc", "ASSISTANT_IPC_SOCKET_DIR": "/run/assistant-ipc",
        "DISABLE_HTTP_AUTH": "false", "VELLUM_UNSAFE_AUTH_BYPASS": "0",
    })
    result = []
    if blaxel:
        # The vendor API needs its injected identity and runtime environment.
        result.append(Service("sandbox-api", ["/usr/local/bin/sandbox-api"], "/app", dict(os.environ),
                              lambda: tcp_ready(8080)))
    result.extend([
        Service("ces", ["bun", "run", "src/main.ts"], "/app/credential-executor", {
            **common, "HOME": str(DATA / "ces-data"), "CES_MODE": "managed", "CES_HEALTH_PORT": "8090",
            "CES_DATA_DIR": str(DATA / "ces-data"), "CREDENTIAL_SECURITY_DIR": str(DATA / "ces-security"),
            "CES_ASSISTANT_DATA_MOUNT": "/data",
        }, lambda: http_ready(8090) and Path("/run/ces-bootstrap/ces.sock").is_socket()),
        Service("assistant", ["/app/assistant/docker-entrypoint.sh"], "/app/assistant", {
            **common, "HOME": "/data", "BASE_DATA_DIR": "/data",
            "BUN_INSTALL": "/data/.bun", "PYTHONUSERBASE": "/data/.python",
            "RUNTIME_HTTP_PORT": "8000", "RUNTIME_HTTP_HOST": "127.0.0.1",
            "GATEWAY_INTERNAL_URL": "http://127.0.0.1:7830",
            "ACTOR_TOKEN_SIGNING_KEY": keys["ACTOR_TOKEN_SIGNING_KEY"],
            "VELLUM_CONFIG_SANDBOX_ENABLED": "false",
        }, lambda: http_ready(8000)),
        Service("gateway", ["bun", "--smol", "run", "src/index.ts"], "/app/gateway", {
            **common, "HOME": str(DATA / "gateway-home"), "GATEWAY_PORT": "7830",
            "GATEWAY_SECURITY_DIR": str(DATA / "gateway-security"), "RUNTIME_HTTP_PORT": "8000",
            "RUNTIME_PROXY_REQUIRE_AUTH": "true", "ASSISTANT_RUNTIME_BASE_URL": "http://127.0.0.1:8000",
            "ACTOR_TOKEN_SIGNING_KEY": keys["ACTOR_TOKEN_SIGNING_KEY"],
            "GUARDIAN_BOOTSTRAP_SECRET": keys["GUARDIAN_BOOTSTRAP_SECRET"],
        }, lambda: http_ready(7830)),
    ])
    return result


class Supervisor:
    def __init__(self, specs, startup_timeout=300, stop_timeout=20, ready_file=READY):
        self.specs = specs
        self.startup_timeout = startup_timeout
        self.stop_timeout = stop_timeout
        self.ready_file = ready_file
        self.children = []
        self.stopping = False

    def signal(self, _signum, _frame):
        self.stopping = True

    def check_children(self):
        for spec, child in self.children:
            code = child.poll()
            if code is not None:
                raise RuntimeError(f"{spec.name} exited unexpectedly (status {code})")

    @staticmethod
    def relay(name, stream):
        with stream:
            while chunk := stream.readline(65536):
                sys.stdout.buffer.write(f"[{name}] ".encode() + chunk)
                sys.stdout.buffer.flush()

    @staticmethod
    def kill_group(child, signum):
        try:
            os.killpg(child.pid, signum)
        except ProcessLookupError:
            pass

    def stop(self):
        self.ready_file.unlink(missing_ok=True)
        # Stop ingress before the assistant, then its credential service.
        for spec, child in reversed(self.children):
            log(f"stopping {spec.name}")
            self.kill_group(child, signal.SIGTERM)
            try:
                child.wait(timeout=self.stop_timeout)
            except subprocess.TimeoutExpired:
                log(f"killing {spec.name} after shutdown timeout")
            self.kill_group(child, signal.SIGKILL)
            child.wait()

    def run(self):
        try:
            for spec in self.specs:
                if self.stopping:
                    return 0
                self.check_children()
                log(f"starting {spec.name}")
                child = subprocess.Popen(spec.command, cwd=spec.cwd, env=spec.env, start_new_session=True,
                                         stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
                self.children.append((spec, child))
                threading.Thread(target=self.relay, args=(spec.name, child.stdout), daemon=True).start()
                deadline = time.monotonic() + self.startup_timeout
                while not self.stopping:
                    self.check_children()
                    if spec.ready():
                        break
                    if time.monotonic() >= deadline:
                        raise RuntimeError(f"{spec.name} did not become ready within {self.startup_timeout}s")
                    time.sleep(0.2)
                if self.stopping:
                    return 0
            self.check_children()
            self.ready_file.touch()
            log("all services ready")
            while not self.stopping:
                self.check_children()
                time.sleep(0.2)
            return 0
        except (OSError, RuntimeError) as exc:
            log(str(exc))
            return 1
        finally:
            self.stop()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("serve", "check"))
    parser.add_argument("--blaxel", action="store_true")
    args = parser.parse_args()
    if args.action == "check":
        return 0 if READY.exists() and all(http_ready(port) for port in PORTS) else 1
    lock, keys = initialize()
    supervisor = Supervisor(services(keys, args.blaxel))
    signal.signal(signal.SIGTERM, supervisor.signal)
    signal.signal(signal.SIGINT, supervisor.signal)
    try:
        return supervisor.run()
    finally:
        lock.close()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, RuntimeError, ValueError) as exc:
        log(str(exc))
        sys.exit(1)

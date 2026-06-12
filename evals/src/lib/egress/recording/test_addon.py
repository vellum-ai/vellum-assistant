"""
Unit tests for addon.py's response- and request-hook behavior.

Plain `unittest`, no third-party deps. Runnable as:

    python3 -m unittest evals/src/lib/egress/recording/test_addon.py

Two groups:

  - `ResponseHookGzipTest` pins the regression where the response hook
    read `raw_content` (the compressed wire bytes) instead of the
    content-decoded body, which made the parser silently fail on every
    gzip'd Anthropic response and left `egress-usage.ndjson` empty, plus
    the payload-inlining behavior. These run against the addon imported
    at module load — mitmproxy is optional there (addon.py degrades to
    `ctx = http = None` when absent), which is fine for the response
    hook.

  - `AllowlistTests` drives the `request` hook's mock-then-allowlist
    dispatch. The request hook needs `http.Response.make`, so these
    install a minimal `mitmproxy` stub into `sys.modules` and reload the
    addon with the env (ALLOW_HOSTS / PLUGIN_FIXTURES_DIR) under test —
    both are read from os.environ at import time. The reload is in-place
    (`importlib.reload`), so the module-level `addon` reference the
    response-hook tests use stays valid.
"""

from __future__ import annotations

import gzip
import importlib
import json
import os
import sys
import tempfile
import types
import unittest
from typing import Optional

import addon


def _anthropic_response_json() -> bytes:
    return json.dumps(
        {
            "model": "claude-sonnet-4-5",
            "usage": {"input_tokens": 16442, "output_tokens": 70},
        }
    ).encode("utf-8")


class _FakeMessage:
    """Mimics mitmproxy's Message: `content` is decoded, `raw_content` is raw."""

    def __init__(
        self,
        *,
        decoded: bytes,
        raw: bytes,
        headers: dict[str, str] | None = None,
    ) -> None:
        self._decoded = decoded
        self.raw_content = raw
        self.headers = headers or {}

    @property
    def content(self) -> bytes:
        return self._decoded


class _FakeRequest(_FakeMessage):
    def __init__(self, *, path: str, decoded: bytes, raw: bytes) -> None:
        super().__init__(decoded=decoded, raw=raw)
        self.pretty_host = "api.anthropic.com"
        self.path = path


class _FakeResponse(_FakeMessage):
    def __init__(
        self, *, decoded: bytes, raw: bytes, content_type: str
    ) -> None:
        super().__init__(
            decoded=decoded,
            raw=raw,
            headers={"content-type": content_type},
        )
        self.status_code = 200


class _FakeFlow:
    def __init__(self, request: _FakeRequest, response: _FakeResponse) -> None:
        self.request = request
        self.response = response


class ResponseHookGzipTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.NamedTemporaryFile(
            mode="w", suffix=".ndjson", delete=False
        )
        self._tmp.close()
        self._orig_path = addon.RECORDING_OUTPUT_PATH
        addon.RECORDING_OUTPUT_PATH = self._tmp.name

    def tearDown(self) -> None:
        addon.RECORDING_OUTPUT_PATH = self._orig_path
        os.unlink(self._tmp.name)

    def _records(self) -> list[dict]:
        with open(self._tmp.name, encoding="utf-8") as fh:
            return [json.loads(line) for line in fh if line.strip()]

    def test_gzip_encoded_response_is_decoded_and_recorded(self) -> None:
        body = _anthropic_response_json()
        flow = _FakeFlow(
            request=_FakeRequest(
                path="/v1/messages",
                decoded=b'{"model":"claude-sonnet-4-5"}',
                raw=b'{"model":"claude-sonnet-4-5"}',
            ),
            response=_FakeResponse(
                decoded=body,
                raw=gzip.compress(body),
                content_type="application/json",
            ),
        )

        addon.response(flow)

        records = self._records()
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["input_tokens"], 16442)
        self.assertEqual(records[0]["output_tokens"], 70)
        self.assertEqual(records[0]["model"], "claude-sonnet-4-5")

    def test_request_and_response_payloads_are_inlined(self) -> None:
        """The hook stores the decoded request/response bodies on the record."""
        # GIVEN an Anthropic response with a distinct request and response body
        request_body = b'{"model":"claude-sonnet-4-5","messages":[]}'
        response_body = _anthropic_response_json()
        flow = _FakeFlow(
            request=_FakeRequest(
                path="/v1/messages",
                decoded=request_body,
                raw=request_body,
            ),
            response=_FakeResponse(
                decoded=response_body,
                raw=response_body,
                content_type="application/json",
            ),
        )

        # WHEN the response hook records it
        addon.response(flow)

        # THEN both payloads are inlined with their full byte length and an
        # un-truncated flag, so the report can show what each request sent/got
        record = self._records()[0]
        self.assertEqual(record["request_body"], request_body.decode())
        self.assertEqual(record["request_body_bytes"], len(request_body))
        self.assertFalse(record["request_body_truncated"])
        self.assertEqual(record["response_body"], response_body.decode())
        self.assertEqual(record["response_body_bytes"], len(response_body))
        self.assertFalse(record["response_body_truncated"])

    def test_oversized_payload_is_truncated_but_byte_count_preserved(self) -> None:
        """Payloads over the cap are truncated; the full byte length survives."""
        # GIVEN a response body larger than the payload cap
        self._orig_cap = addon.MAX_PAYLOAD_CHARS
        addon.MAX_PAYLOAD_CHARS = 16
        self.addCleanup(setattr, addon, "MAX_PAYLOAD_CHARS", self._orig_cap)
        big_text = "x" * 100
        response_body = json.dumps(
            {
                "model": "claude-sonnet-4-5",
                "usage": {"input_tokens": 1, "output_tokens": 1},
                "pad": big_text,
            }
        ).encode("utf-8")
        flow = _FakeFlow(
            request=_FakeRequest(path="/v1/messages", decoded=b"{}", raw=b"{}"),
            response=_FakeResponse(
                decoded=response_body,
                raw=response_body,
                content_type="application/json",
            ),
        )

        # WHEN the response hook records it
        addon.response(flow)

        # THEN the stored text is capped but the real byte length is preserved
        # and the truncation flag is set
        record = self._records()[0]
        self.assertEqual(len(record["response_body"]), 16)
        self.assertEqual(record["response_body_bytes"], len(response_body))
        self.assertTrue(record["response_body_truncated"])

    def test_falls_back_to_raw_when_decode_raises(self) -> None:
        body = _anthropic_response_json()

        class _RaisingResponse(_FakeResponse):
            @property
            def content(self) -> bytes:
                raise ValueError("invalid content-encoding")

        flow = _FakeFlow(
            request=_FakeRequest(
                path="/v1/messages", decoded=b"{}", raw=b"{}"
            ),
            response=_RaisingResponse(
                decoded=body,
                raw=body,
                content_type="application/json",
            ),
        )

        addon.response(flow)

        records = self._records()
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["input_tokens"], 16442)


def _install_mitmproxy_stub() -> None:
    """Install a minimal fake `mitmproxy` package into sys.modules.

    Only the surface the addon touches is provided: `ctx.log.{info,warn}`
    (no-ops) and `http.Response.make(status, body, headers)` returning a
    simple namespace we can assert against.
    """

    class _FakeResponse:
        def __init__(self, status_code: int, content: bytes, headers: dict):
            self.status_code = status_code
            self.content = content
            self.headers = headers

    class _FakeResponseFactory:
        @staticmethod
        def make(status: int, body: bytes, headers: dict) -> "_FakeResponse":
            return _FakeResponse(status, body, headers)

    mitmproxy = types.ModuleType("mitmproxy")

    log = types.SimpleNamespace(info=lambda *_: None, warn=lambda *_: None)
    ctx = types.SimpleNamespace(log=log)

    http = types.SimpleNamespace(Response=_FakeResponseFactory)

    mitmproxy.ctx = ctx  # type: ignore[attr-defined]
    mitmproxy.http = http  # type: ignore[attr-defined]

    sys.modules["mitmproxy"] = mitmproxy


def _load_addon(*, allow_hosts: str, fixtures_dir: Optional[str] = None):
    """Reload addon.py with the given env so module-level config refreshes."""
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    _install_mitmproxy_stub()
    os.environ["ALLOW_HOSTS"] = allow_hosts
    if fixtures_dir is None:
        os.environ.pop("PLUGIN_FIXTURES_DIR", None)
    else:
        os.environ["PLUGIN_FIXTURES_DIR"] = fixtures_dir
    if "addon" in sys.modules:
        return importlib.reload(sys.modules["addon"])
    return importlib.import_module("addon")


class _AllowlistFakeRequest:
    def __init__(self, host: str, path: str = "/v1/messages", method: str = "POST"):
        self.pretty_host = host
        self.path = path
        self.method = method


class _AllowlistFakeFlow:
    def __init__(self, request: _AllowlistFakeRequest):
        self.request = request
        self.response = None


class AllowlistTests(unittest.TestCase):
    def test_blocks_a_host_not_in_the_allowlist_with_403(self) -> None:
        addon = _load_addon(allow_hosts="api.anthropic.com")
        flow = _AllowlistFakeFlow(_AllowlistFakeRequest("evil.example.com"))
        addon.request(flow)
        self.assertIsNotNone(flow.response)
        self.assertEqual(flow.response.status_code, 403)
        self.assertIn(b"blocked by vellum-evals egress jail", flow.response.content)

    def test_allows_an_allowlisted_host_to_fall_through(self) -> None:
        # An allowed host gets no short-circuit response — it flows to
        # mitmproxy's normal upstream path. We assert `flow.response`
        # stays None (the hook returned without setting it).
        addon = _load_addon(allow_hosts="api.anthropic.com,api.openai.com")
        flow = _AllowlistFakeFlow(_AllowlistFakeRequest("api.anthropic.com"))
        addon.request(flow)
        self.assertIsNone(flow.response)

    def test_allowlist_match_is_case_insensitive(self) -> None:
        addon = _load_addon(allow_hosts="API.Anthropic.com")
        flow = _AllowlistFakeFlow(_AllowlistFakeRequest("api.anthropic.com"))
        addon.request(flow)
        self.assertIsNone(flow.response)

    def test_blocks_when_allowlist_is_empty(self) -> None:
        # A sidecar with no ALLOW_HOSTS blocks everything (fail closed).
        addon = _load_addon(allow_hosts="")
        flow = _AllowlistFakeFlow(_AllowlistFakeRequest("api.anthropic.com"))
        addon.request(flow)
        self.assertEqual(flow.response.status_code, 403)

    def test_mocked_github_host_is_served_even_though_not_allowlisted(self) -> None:
        # GitHub is intentionally NOT in ALLOW_HOSTS — it's served from
        # the fixtures dir. The mock must win before the allowlist would
        # 403 it. We point PLUGIN_FIXTURES_DIR at a temp dir with a
        # `plugins/<name>/` layout so the contents-API mock returns 200.
        with tempfile.TemporaryDirectory() as fixtures:
            plugin_dir = os.path.join(fixtures, "demo-plugin")
            os.makedirs(plugin_dir)
            with open(os.path.join(plugin_dir, "SKILL.md"), "w") as fh:
                fh.write("# demo\n")
            addon = _load_addon(
                allow_hosts="api.anthropic.com",
                fixtures_dir=fixtures,
            )
            flow = _AllowlistFakeFlow(
                _AllowlistFakeRequest(
                    "api.github.com",
                    path="/repos/vellum-ai/vellum-assistant/contents/plugins/demo-plugin",
                    method="GET",
                )
            )
            addon.request(flow)
            self.assertIsNotNone(flow.response)
            self.assertEqual(flow.response.status_code, 200)
            self.assertEqual(
                flow.response.headers.get("x-mocked-by"),
                "vellum-evals-egress-mock",
            )

    def test_unmocked_github_path_falls_to_allowlist_and_is_blocked(self) -> None:
        # With fixtures mounted but a path the mock doesn't recognize,
        # the request falls through to the allowlist — github isn't
        # allowlisted, so it 403s rather than egressing to real github.
        with tempfile.TemporaryDirectory() as fixtures:
            addon = _load_addon(
                allow_hosts="api.anthropic.com",
                fixtures_dir=fixtures,
            )
            flow = _AllowlistFakeFlow(
                _AllowlistFakeRequest("api.github.com", path="/zen", method="GET")
            )
            addon.request(flow)
            self.assertEqual(flow.response.status_code, 403)


if __name__ == "__main__":
    unittest.main()

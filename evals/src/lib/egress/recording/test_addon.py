"""
Unit tests for addon.py's response hook body handling.

Plain `unittest`, no third-party deps (mitmproxy is optional at import
time — addon.py degrades to `ctx = http = None` when it's absent, which
is exactly the case here). Runnable as:

    python3 -m unittest evals/src/lib/egress/recording/test_addon.py

These tests pin the regression where the hook read `raw_content` (the
compressed wire bytes) instead of the content-decoded body, which made
the parser silently fail on every gzip'd Anthropic response and left
`egress-usage.ndjson` empty.
"""

from __future__ import annotations

import gzip
import json
import os
import tempfile
import unittest

import addon


def _anthropic_response_json() -> bytes:
    return json.dumps(
        {
            "model": "claude-sonnet-4-5",
            "usage": {"input_tokens": 16442, "output_tokens": 70},
        }
    ).encode("utf-8")


def _fireworks_response_json() -> bytes:
    return json.dumps(
        {
            "model": "accounts/fireworks/models/minimax-m3",
            "usage": {"prompt_tokens": 4096, "completion_tokens": 128},
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
    def __init__(
        self,
        *,
        path: str,
        decoded: bytes,
        raw: bytes,
        host: str = "api.anthropic.com",
    ) -> None:
        super().__init__(decoded=decoded, raw=raw)
        self.pretty_host = host
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

    def test_fireworks_response_is_dispatched_to_openai_compatible_parser(
        self,
    ) -> None:
        """A Fireworks chat-completions response records a fireworks usage row."""
        # GIVEN a non-streaming Fireworks chat-completions response
        response_body = _fireworks_response_json()
        flow = _FakeFlow(
            request=_FakeRequest(
                host="api.fireworks.ai",
                path="/inference/v1/chat/completions",
                decoded=b'{"model":"accounts/fireworks/models/minimax-m3"}',
                raw=b'{"model":"accounts/fireworks/models/minimax-m3"}',
            ),
            response=_FakeResponse(
                decoded=response_body,
                raw=response_body,
                content_type="application/json",
            ),
        )

        # WHEN the response hook records it
        addon.response(flow)

        # THEN the record is labeled fireworks and maps prompt/completion
        # tokens to input/output tokens
        record = self._records()[0]
        self.assertEqual(record["provider"], "fireworks")
        self.assertEqual(record["input_tokens"], 4096)
        self.assertEqual(record["output_tokens"], 128)
        self.assertEqual(
            record["model"], "accounts/fireworks/models/minimax-m3"
        )

    def test_unmetered_host_is_skipped(self) -> None:
        """A response from a non-parsed allowlisted host records nothing."""
        # GIVEN a Gemini response (an allowlisted host with no parser)
        response_body = json.dumps(
            {"usageMetadata": {"promptTokenCount": 10}}
        ).encode("utf-8")
        flow = _FakeFlow(
            request=_FakeRequest(
                host="generativelanguage.googleapis.com",
                path="/v1beta/models/gemini-2.5-pro:generateContent",
                decoded=b"{}",
                raw=b"{}",
            ),
            response=_FakeResponse(
                decoded=response_body,
                raw=response_body,
                content_type="application/json",
            ),
        )

        # WHEN the response hook runs
        addon.response(flow)

        # THEN no usage record is written
        self.assertEqual(self._records(), [])

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


if __name__ == "__main__":
    unittest.main()

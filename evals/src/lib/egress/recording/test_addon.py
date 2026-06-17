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


def _fireworks_streaming_sse() -> bytes:
    """SSE frames a Fireworks server sends with include_usage streaming.

    Content chunks carry `choices`, the terminal chunk carries the top-level
    `usage`, then the `[DONE]` sentinel.
    """
    frames = [
        "data: "
        + json.dumps(
            {
                "model": "accounts/fireworks/models/minimax-m3",
                "choices": [{"index": 0, "delta": {"content": "Hi"}}],
            }
        ),
        "data: "
        + json.dumps(
            {
                "model": "accounts/fireworks/models/minimax-m3",
                "choices": [],
                "usage": {"prompt_tokens": 4096, "completion_tokens": 128},
            }
        ),
        "data: [DONE]",
    ]
    return "\n\n".join(frames).encode("utf-8")


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
        timestamp_start: float | None = None,
    ) -> None:
        super().__init__(decoded=decoded, raw=raw)
        self.pretty_host = host
        self.path = path
        self.timestamp_start = timestamp_start


class _FakeResponse(_FakeMessage):
    def __init__(
        self,
        *,
        decoded: bytes,
        raw: bytes,
        content_type: str,
        content_encoding: str | None = None,
        timestamp_end: float | None = None,
    ) -> None:
        headers = {"content-type": content_type}
        if content_encoding is not None:
            headers["content-encoding"] = content_encoding
        super().__init__(decoded=decoded, raw=raw, headers=headers)
        self.status_code = 200
        # mitmproxy assigns a callable here to switch on pass-through streaming.
        self.stream: object = False
        self.timestamp_end = timestamp_end


class _FakeFlow:
    def __init__(self, request: _FakeRequest, response: _FakeResponse) -> None:
        self.request = request
        self.response = response
        self.metadata: dict[str, object] = {}


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

    def test_openai_responses_host_is_not_recorded(self) -> None:
        """OpenAI's `api.openai.com` is intentionally left out of the recorded set.

        The assistant's `openai` provider speaks the Responses API
        (`/v1/responses`), which the chat-completions parser cannot read, so the
        host is excluded from interception rather than recorded as $0.
        """
        # GIVEN an OpenAI Responses API response on api.openai.com
        response_body = json.dumps(
            {
                "model": "gpt-5.2",
                "usage": {"input_tokens": 100, "output_tokens": 20},
            }
        ).encode("utf-8")
        flow = _FakeFlow(
            request=_FakeRequest(
                host="api.openai.com",
                path="/v1/responses",
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

        # THEN no usage record is written and the host is not in the recorded set
        self.assertEqual(self._records(), [])
        self.assertFalse(addon._is_recorded_host("api.openai.com"))
        self.assertNotIn("api.openai.com", addon.OPENAI_COMPATIBLE_HOSTS)

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

    def test_round_trip_latency_is_recorded_in_ms(self) -> None:
        """The hook records proxy-observed round-trip latency as `duration_ms`."""
        # GIVEN an Anthropic response whose request/response carry mitmproxy's
        # epoch-second start/end stamps 2.5s apart
        body = _anthropic_response_json()
        flow = _FakeFlow(
            request=_FakeRequest(
                path="/v1/messages",
                decoded=b"{}",
                raw=b"{}",
                timestamp_start=1000.0,
            ),
            response=_FakeResponse(
                decoded=body,
                raw=body,
                content_type="application/json",
                timestamp_end=1002.5,
            ),
        )

        # WHEN the response hook records it
        addon.response(flow)

        # THEN the record carries the round-trip latency in whole ms
        self.assertEqual(self._records()[0]["duration_ms"], 2500)

    def test_duration_is_none_when_timestamps_missing(self) -> None:
        """`duration_ms` is null when mitmproxy left no usable timestamps."""
        # GIVEN a flow whose request/response carry no start/end stamps
        body = _anthropic_response_json()
        flow = _FakeFlow(
            request=_FakeRequest(path="/v1/messages", decoded=b"{}", raw=b"{}"),
            response=_FakeResponse(
                decoded=body, raw=body, content_type="application/json"
            ),
        )

        # WHEN the response hook records it
        addon.response(flow)

        # THEN duration is recorded as null rather than a bogus number
        self.assertIsNone(self._records()[0]["duration_ms"])

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


class SseAccumulatorTest(unittest.TestCase):
    def test_passes_each_chunk_through_unchanged_and_joins_body(self) -> None:
        """The tee returns every chunk unmodified and exposes the full body."""
        # GIVEN a streaming accumulator and a sequence of SSE chunks
        accumulator = addon._SseStreamAccumulator()
        chunks = [b"data: a\n\n", b"data: b\n\n", b""]

        # WHEN mitmproxy feeds each chunk (the empty chunk marks end-of-stream)
        returned = [accumulator(chunk) for chunk in chunks]

        # THEN every chunk is returned byte-for-byte unchanged
        self.assertEqual(returned, chunks)
        # AND the accumulated body is the concatenation of the non-empty chunks
        self.assertEqual(accumulator.body, b"data: a\n\ndata: b\n\n")


class ResponseStreamingTest(unittest.TestCase):
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

    def _sse_flow(
        self,
        *,
        host: str = "api.fireworks.ai",
        content_type: str = "text/event-stream; charset=utf-8",
        content_encoding: str | None = None,
    ) -> _FakeFlow:
        return _FakeFlow(
            request=_FakeRequest(
                host=host,
                path="/inference/v1/chat/completions",
                decoded=b'{"model":"accounts/fireworks/models/minimax-m3"}',
                raw=b'{"model":"accounts/fireworks/models/minimax-m3"}',
            ),
            # A streamed response leaves mitmproxy's body buffer empty; the
            # full body arrives only through the accumulator.
            response=_FakeResponse(
                decoded=b"",
                raw=b"",
                content_type=content_type,
                content_encoding=content_encoding,
            ),
        )

    def test_sse_response_streams_through_and_records_usage(self) -> None:
        """A recorded-host SSE response streams chunk-by-chunk, usage parsed."""
        # GIVEN a Fireworks SSE response on a recorded host
        flow = self._sse_flow()

        # WHEN responseheaders runs, then mitmproxy tees each chunk through the
        # accumulator, then the response hook fires at end-of-stream
        addon.responseheaders(flow)
        passthrough = [
            flow.response.stream(chunk + b"\n\n")
            for chunk in _fireworks_streaming_sse().split(b"\n\n")
            if chunk
        ]
        addon.response(flow)

        # THEN the response was switched into pass-through streaming
        self.assertIsInstance(flow.response.stream, addon._SseStreamAccumulator)
        # AND every streamed chunk reached the client unchanged
        self.assertTrue(all(returned for returned in passthrough))
        # AND usage was parsed from the accumulated body and recorded
        record = self._records()[0]
        self.assertEqual(record["provider"], "fireworks")
        self.assertEqual(record["input_tokens"], 4096)
        self.assertEqual(record["output_tokens"], 128)

    def test_non_sse_response_stays_buffered(self) -> None:
        """A JSON response is left on mitmproxy's default buffered path."""
        # GIVEN a recorded-host response that is not an event stream
        flow = self._sse_flow(content_type="application/json")

        # WHEN the responseheaders hook runs
        addon.responseheaders(flow)

        # THEN streaming is not enabled and no accumulator is stashed
        self.assertFalse(flow.response.stream)
        self.assertNotIn(addon._STREAM_ACCUMULATOR_KEY, flow.metadata)

    def test_content_encoded_sse_stays_buffered(self) -> None:
        """A content-encoded SSE body is not accumulated as compressed bytes."""
        # GIVEN an SSE response that carries a Content-Encoding
        flow = self._sse_flow(content_encoding="gzip")

        # WHEN the responseheaders hook runs
        addon.responseheaders(flow)

        # THEN streaming is not enabled (the parser must not see raw gzip bytes)
        self.assertFalse(flow.response.stream)
        self.assertNotIn(addon._STREAM_ACCUMULATOR_KEY, flow.metadata)

    def test_non_recorded_host_is_not_streamed(self) -> None:
        """An SSE response from an unparsed host is left untouched."""
        # GIVEN an SSE response from an allowlisted host with no parser
        flow = self._sse_flow(host="generativelanguage.googleapis.com")

        # WHEN the responseheaders hook runs
        addon.responseheaders(flow)

        # THEN streaming is not enabled for the unrecorded host
        self.assertFalse(flow.response.stream)
        self.assertNotIn(addon._STREAM_ACCUMULATOR_KEY, flow.metadata)


if __name__ == "__main__":
    unittest.main()

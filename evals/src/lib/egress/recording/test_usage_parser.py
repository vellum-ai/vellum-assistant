"""
Unit tests for usage_parser.py.

Plain `unittest`, no third-party deps. Runnable as:

    python3 -m unittest evals/src/lib/egress/recording/test_usage_parser.py

The Bun test sweep shells out to this via `recording-parser.test.ts` so
the Python parser stays covered alongside the TypeScript surface.
"""

from __future__ import annotations

import json
import unittest

from usage_parser import (
    parse_anthropic_messages_response,
    _parse_anthropic_non_streaming,
    _parse_anthropic_streaming,
)


NON_STREAMING_REQUEST_BODY = json.dumps(
    {
        "model": "claude-sonnet-4-5",
        "messages": [{"role": "user", "content": "hi"}],
    }
).encode("utf-8")

STREAMING_REQUEST_BODY = json.dumps(
    {
        "model": "claude-sonnet-4-5",
        "messages": [{"role": "user", "content": "hi"}],
        "stream": True,
    }
).encode("utf-8")


def _non_streaming_response() -> bytes:
    return json.dumps(
        {
            "id": "msg_01",
            "type": "message",
            "model": "claude-sonnet-4-5",
            "content": [{"type": "text", "text": "Hello!"}],
            "usage": {
                "input_tokens": 1234,
                "output_tokens": 567,
                "cache_creation_input_tokens": 100,
                "cache_read_input_tokens": 50,
            },
        }
    ).encode("utf-8")


def _streaming_response() -> bytes:
    # Realistic shape of the SSE frames Anthropic sends. Each event is
    # double-newline-separated; each frame has a `data:` line that is a
    # JSON payload.
    frames = [
        (
            "event: message_start\n"
            "data: "
            + json.dumps(
                {
                    "type": "message_start",
                    "message": {
                        "id": "msg_02",
                        "type": "message",
                        "model": "claude-sonnet-4-5",
                        "content": [],
                        "usage": {
                            "input_tokens": 2000,
                            "output_tokens": 0,
                            "cache_creation_input_tokens": 50,
                            "cache_read_input_tokens": 25,
                        },
                    },
                }
            )
            + "\n"
        ),
        "event: content_block_start\n"
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n',
        "event: content_block_delta\n"
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n',
        "event: ping\n" 'data: {"type":"ping"}\n',
        "event: content_block_stop\n"
        'data: {"type":"content_block_stop","index":0}\n',
        (
            "event: message_delta\n"
            "data: "
            + json.dumps(
                {
                    "type": "message_delta",
                    "delta": {"stop_reason": "end_turn"},
                    "usage": {"output_tokens": 800},
                }
            )
            + "\n"
        ),
        "event: message_stop\n" 'data: {"type":"message_stop"}\n',
    ]
    return "\n".join(frames).encode("utf-8")


class NonStreamingTests(unittest.TestCase):
    def test_extracts_all_usage_fields_from_non_streaming_response(self) -> None:
        record = _parse_anthropic_non_streaming(_non_streaming_response())
        self.assertEqual(
            record,
            {
                "provider": "anthropic",
                "model": "claude-sonnet-4-5",
                "input_tokens": 1234,
                "output_tokens": 567,
                "cache_creation_input_tokens": 100,
                "cache_read_input_tokens": 50,
            },
        )

    def test_omits_missing_cache_fields(self) -> None:
        # Some response payloads omit cache_* (smaller prompts, no cache).
        body = json.dumps(
            {
                "model": "claude-haiku-4-5",
                "usage": {"input_tokens": 100, "output_tokens": 50},
            }
        ).encode("utf-8")
        record = _parse_anthropic_non_streaming(body)
        self.assertEqual(
            record,
            {
                "provider": "anthropic",
                "model": "claude-haiku-4-5",
                "input_tokens": 100,
                "output_tokens": 50,
            },
        )

    def test_rejects_non_json_response_body(self) -> None:
        self.assertIsNone(_parse_anthropic_non_streaming(b"not json"))
        self.assertIsNone(_parse_anthropic_non_streaming(b""))

    def test_rejects_json_without_usage_field(self) -> None:
        body = json.dumps({"id": "msg_xx", "model": "claude-sonnet"}).encode("utf-8")
        self.assertIsNone(_parse_anthropic_non_streaming(body))

    def test_rejects_booleans_as_token_counts(self) -> None:
        # Defensive: ensure a malformed `True` doesn't get summed as 1.
        body = json.dumps(
            {
                "model": "claude-sonnet",
                "usage": {"input_tokens": True, "output_tokens": 50},
            }
        ).encode("utf-8")
        record = _parse_anthropic_non_streaming(body)
        # input_tokens is rejected; output_tokens is kept.
        self.assertNotIn("input_tokens", record or {})
        self.assertEqual((record or {}).get("output_tokens"), 50)


class StreamingTests(unittest.TestCase):
    def test_combines_message_start_and_message_delta_into_one_record(self) -> None:
        record = _parse_anthropic_streaming(_streaming_response())
        self.assertEqual(
            record,
            {
                "provider": "anthropic",
                "model": "claude-sonnet-4-5",
                "input_tokens": 2000,
                # output_tokens from message_delta, overwriting the
                # 0-output_tokens from message_start.
                "output_tokens": 800,
                "cache_creation_input_tokens": 50,
                "cache_read_input_tokens": 25,
            },
        )

    def test_handles_streaming_response_with_no_message_delta(self) -> None:
        # Some early-termination paths only emit message_start. The
        # input-side counters still need to be recorded.
        body = (
            "event: message_start\n"
            'data: {"type":"message_start","message":{"model":"claude-haiku-4-5","usage":{"input_tokens":100,"output_tokens":0}}}\n\n'
        ).encode("utf-8")
        record = _parse_anthropic_streaming(body)
        self.assertEqual(
            record,
            {
                "provider": "anthropic",
                "model": "claude-haiku-4-5",
                "input_tokens": 100,
                "output_tokens": 0,
            },
        )

    def test_returns_none_for_completely_empty_stream(self) -> None:
        self.assertIsNone(_parse_anthropic_streaming(b""))

    def test_skips_malformed_data_lines_without_crashing(self) -> None:
        body = (
            "event: ping\n"
            "data: not-json\n\n"
            "event: message_start\n"
            'data: {"type":"message_start","message":{"model":"m","usage":{"input_tokens":10}}}\n\n'
        ).encode("utf-8")
        record = _parse_anthropic_streaming(body)
        self.assertEqual(
            record,
            {"provider": "anthropic", "model": "m", "input_tokens": 10},
        )


class TopLevelDispatchTests(unittest.TestCase):
    def test_routes_event_stream_content_type_to_streaming_parser(self) -> None:
        record = parse_anthropic_messages_response(
            request_path="/v1/messages",
            request_body=STREAMING_REQUEST_BODY,
            response_content_type="text/event-stream; charset=utf-8",
            response_body=_streaming_response(),
        )
        assert record is not None
        self.assertEqual(record["output_tokens"], 800)

    def test_routes_application_json_content_type_to_non_streaming_parser(self) -> None:
        record = parse_anthropic_messages_response(
            request_path="/v1/messages",
            request_body=NON_STREAMING_REQUEST_BODY,
            response_content_type="application/json",
            response_body=_non_streaming_response(),
        )
        assert record is not None
        self.assertEqual(record["output_tokens"], 567)

    def test_falls_back_to_request_body_stream_flag_when_content_type_is_missing(
        self,
    ) -> None:
        record = parse_anthropic_messages_response(
            request_path="/v1/messages",
            request_body=STREAMING_REQUEST_BODY,
            response_content_type="",
            response_body=_streaming_response(),
        )
        assert record is not None
        self.assertEqual(record["output_tokens"], 800)

    def test_skips_non_messages_paths(self) -> None:
        # /v1/models or any other Anthropic endpoint we don't care about
        # must not return a record.
        self.assertIsNone(
            parse_anthropic_messages_response(
                request_path="/v1/models",
                request_body=b"",
                response_content_type="application/json",
                response_body=b'{"data":[]}',
            )
        )

    def test_records_beta_namespace_messages_path(self) -> None:
        # The Anthropic SDK's `client.beta.messages` namespace posts to
        # `/v1/messages?beta=true`; the main agent loop uses it for every
        # non-Haiku turn, so its query string must not cause the dominant
        # model traffic to be dropped.
        record = parse_anthropic_messages_response(
            request_path="/v1/messages?beta=true",
            request_body=STREAMING_REQUEST_BODY,
            response_content_type="text/event-stream; charset=utf-8",
            response_body=_streaming_response(),
        )
        assert record is not None
        self.assertEqual(record["output_tokens"], 800)

    def test_skips_beta_count_tokens_path(self) -> None:
        # `/v1/messages/count_tokens?beta=true` carries no usage and must
        # stay excluded even after the query string is stripped.
        self.assertIsNone(
            parse_anthropic_messages_response(
                request_path="/v1/messages/count_tokens?beta=true",
                request_body=b"",
                response_content_type="application/json",
                response_body=b'{"input_tokens":42}',
            )
        )


if __name__ == "__main__":
    unittest.main()

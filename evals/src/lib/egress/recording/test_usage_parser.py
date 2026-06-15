"""
Unit tests for usage_parser.py.

Plain `unittest`, no third-party deps. Runnable as:

    python3 -m unittest evals/src/lib/egress/recording/test_usage_parser.py

The `python-egress-checks` CI job runs these via
`python3 -m unittest discover -p 'test_*.py'` in this directory.
"""

from __future__ import annotations

import json
import unittest

from usage_parser import (
    parse_anthropic_messages_response,
    parse_openai_chat_completions_response,
    _parse_anthropic_non_streaming,
    _parse_anthropic_streaming,
    _parse_openai_non_streaming,
    _parse_openai_streaming,
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
                # The full usage object is forwarded verbatim for tracking.
                "usage": {
                    "input_tokens": 1234,
                    "output_tokens": 567,
                    "cache_creation_input_tokens": 100,
                    "cache_read_input_tokens": 50,
                },
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
                "usage": {"input_tokens": 100, "output_tokens": 50},
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

    def test_forwards_cache_creation_ttl_breakdown(self) -> None:
        # Anthropic prices 5-minute vs 1-hour cache writes differently, so
        # the `cache_creation` split must be preserved (both hoisted to the
        # top level for the pricer and kept inside the full `usage` object).
        body = json.dumps(
            {
                "model": "claude-sonnet-4-6",
                "usage": {
                    "input_tokens": 3,
                    "output_tokens": 69,
                    "cache_creation_input_tokens": 500,
                    "cache_read_input_tokens": 100,
                    "cache_creation": {
                        "ephemeral_5m_input_tokens": 300,
                        "ephemeral_1h_input_tokens": 200,
                    },
                },
            }
        ).encode("utf-8")
        record = _parse_anthropic_non_streaming(body)
        assert record is not None
        self.assertEqual(
            record["cache_creation"],
            {"ephemeral_5m_input_tokens": 300, "ephemeral_1h_input_tokens": 200},
        )
        self.assertEqual(
            record["usage"]["cache_creation"]["ephemeral_1h_input_tokens"], 200
        )


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
                # message_start usage with output_tokens overwritten by the
                # message_delta total, forwarded as the full usage object.
                "usage": {
                    "input_tokens": 2000,
                    "output_tokens": 800,
                    "cache_creation_input_tokens": 50,
                    "cache_read_input_tokens": 25,
                },
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
                "usage": {"input_tokens": 100, "output_tokens": 0},
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
            {
                "provider": "anthropic",
                "model": "m",
                "input_tokens": 10,
                "usage": {"input_tokens": 10},
            },
        )


# --- OpenAI-compatible (OpenAI + Fireworks) chat-completions fixtures ---

MINIMAX_MODEL = "accounts/fireworks/models/minimax-m3"

OPENAI_NON_STREAMING_REQUEST_BODY = json.dumps(
    {
        "model": MINIMAX_MODEL,
        "messages": [{"role": "user", "content": "hi"}],
    }
).encode("utf-8")

OPENAI_STREAMING_REQUEST_BODY = json.dumps(
    {
        "model": MINIMAX_MODEL,
        "messages": [{"role": "user", "content": "hi"}],
        "stream": True,
        "stream_options": {"include_usage": True},
    }
).encode("utf-8")


def _openai_non_streaming_response() -> bytes:
    return json.dumps(
        {
            "id": "chatcmpl-01",
            "object": "chat.completion",
            "model": MINIMAX_MODEL,
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": "Hello!"},
                    "finish_reason": "stop",
                }
            ],
            "usage": {
                "prompt_tokens": 1234,
                "completion_tokens": 567,
                "total_tokens": 1801,
                # Cached subset is already folded into prompt_tokens.
                "prompt_tokens_details": {"cached_tokens": 200},
            },
        }
    ).encode("utf-8")


def _openai_streaming_response() -> bytes:
    # Shape of the SSE frames an OpenAI-compatible server sends when
    # `stream_options: {include_usage: true}` is set: content chunks carry
    # `choices`, then a terminal chunk carries an empty `choices` array and
    # the populated top-level `usage`, then the `[DONE]` sentinel.
    frames = [
        "data: "
        + json.dumps(
            {
                "id": "chatcmpl-02",
                "object": "chat.completion.chunk",
                "model": MINIMAX_MODEL,
                "choices": [
                    {"index": 0, "delta": {"role": "assistant"}}
                ],
            }
        ),
        "data: "
        + json.dumps(
            {
                "id": "chatcmpl-02",
                "object": "chat.completion.chunk",
                "model": MINIMAX_MODEL,
                "choices": [
                    {"index": 0, "delta": {"content": "Hi"}}
                ],
            }
        ),
        "data: "
        + json.dumps(
            {
                "id": "chatcmpl-02",
                "object": "chat.completion.chunk",
                "model": MINIMAX_MODEL,
                "choices": [],
                "usage": {
                    "prompt_tokens": 2000,
                    "completion_tokens": 800,
                    "total_tokens": 2800,
                },
            }
        ),
        "data: [DONE]",
    ]
    return "\n\n".join(frames).encode("utf-8")


class OpenAICompatibleNonStreamingTests(unittest.TestCase):
    def test_maps_prompt_and_completion_tokens_to_input_and_output(self) -> None:
        """
        Tests that a non-streaming chat-completions body maps
        prompt/completion tokens onto the evals record's input/output.
        """
        # GIVEN a non-streaming Fireworks chat-completions response
        body = _openai_non_streaming_response()

        # WHEN it is parsed with the fireworks provider label
        record = _parse_openai_non_streaming("fireworks", body)

        # THEN prompt_tokens -> input_tokens, completion_tokens -> output_tokens
        # AND the cached subset is hoisted to cache_read_input_tokens
        # AND the provider + model + raw usage are preserved
        self.assertEqual(
            record,
            {
                "provider": "fireworks",
                "model": MINIMAX_MODEL,
                "input_tokens": 1234,
                "output_tokens": 567,
                "cache_read_input_tokens": 200,
                "usage": {
                    "prompt_tokens": 1234,
                    "completion_tokens": 567,
                    "total_tokens": 1801,
                    "prompt_tokens_details": {"cached_tokens": 200},
                },
            },
        )

    def test_hoists_cached_tokens_to_cache_read_input_tokens(self) -> None:
        """
        Tests that the cached-token subset is hoisted to a top-level
        cache_read_input_tokens field so the pricer can re-price it at a
        provider's discounted cache-read rate.
        """
        # GIVEN a response whose usage carries prompt_tokens_details.cached_tokens
        body = _openai_non_streaming_response()

        # WHEN it is parsed
        record = _parse_openai_non_streaming("fireworks", body)
        assert record is not None

        # THEN the cached subset surfaces top-level while staying counted
        # inside the inclusive input_tokens (the pricer subtracts it back out)
        self.assertEqual(record["cache_read_input_tokens"], 200)
        self.assertEqual(record["input_tokens"], 1234)

    def test_labels_record_with_the_provider_argument(self) -> None:
        """
        Tests that the provider label is taken from the caller's argument,
        since OpenAI and Fireworks share an identical wire format.
        """
        # GIVEN the same wire body but parsed as openai rather than fireworks
        body = _openai_non_streaming_response()

        # WHEN it is parsed with the openai provider label
        record = _parse_openai_non_streaming("openai", body)
        assert record is not None

        # THEN the record carries the supplied provider
        self.assertEqual(record["provider"], "openai")

    def test_rejects_non_json_response_body(self) -> None:
        """
        Tests that malformed / empty bodies parse to None.
        """
        # GIVEN non-JSON and empty bodies
        # WHEN each is parsed
        # THEN both return None
        self.assertIsNone(_parse_openai_non_streaming("fireworks", b"not json"))
        self.assertIsNone(_parse_openai_non_streaming("fireworks", b""))

    def test_rejects_json_without_usage_field(self) -> None:
        """
        Tests that a chat-completions body lacking `usage` parses to None.
        """
        # GIVEN a response with no usage object
        body = json.dumps({"id": "chatcmpl-x", "model": MINIMAX_MODEL}).encode(
            "utf-8"
        )

        # WHEN it is parsed
        # THEN it returns None
        self.assertIsNone(_parse_openai_non_streaming("fireworks", body))

    def test_rejects_booleans_as_token_counts(self) -> None:
        """
        Tests that a malformed boolean token count is not summed as 1.
        """
        # GIVEN a usage object whose prompt_tokens is a boolean
        body = json.dumps(
            {
                "model": MINIMAX_MODEL,
                "usage": {"prompt_tokens": True, "completion_tokens": 50},
            }
        ).encode("utf-8")

        # WHEN it is parsed
        record = _parse_openai_non_streaming("fireworks", body)

        # THEN the boolean prompt_tokens is rejected and completion_tokens kept
        self.assertNotIn("input_tokens", record or {})
        self.assertEqual((record or {}).get("output_tokens"), 50)


class OpenAICompatibleStreamingTests(unittest.TestCase):
    def test_reads_usage_from_terminal_chunk(self) -> None:
        """
        Tests that the terminal include_usage chunk's totals are recorded.
        """
        # GIVEN a streaming response whose final chunk carries usage
        body = _openai_streaming_response()

        # WHEN it is parsed
        record = _parse_openai_streaming("fireworks", body)

        # THEN the usage chunk's prompt/completion tokens map to input/output
        # AND the model is read from the content chunks
        self.assertEqual(
            record,
            {
                "provider": "fireworks",
                "model": MINIMAX_MODEL,
                "input_tokens": 2000,
                "output_tokens": 800,
                "usage": {
                    "prompt_tokens": 2000,
                    "completion_tokens": 800,
                    "total_tokens": 2800,
                },
            },
        )

    def test_returns_none_when_no_usage_chunk_present(self) -> None:
        """
        Tests that a stream with no usage chunk (include_usage omitted)
        parses to None rather than a partial record.
        """
        # GIVEN a stream of content chunks with no terminal usage chunk
        frames = [
            "data: "
            + json.dumps(
                {
                    "model": MINIMAX_MODEL,
                    "choices": [{"index": 0, "delta": {"content": "Hi"}}],
                }
            ),
            "data: [DONE]",
        ]
        body = "\n\n".join(frames).encode("utf-8")

        # WHEN it is parsed
        record = _parse_openai_streaming("fireworks", body)

        # THEN no record is produced
        self.assertIsNone(record)

    def test_returns_none_for_completely_empty_stream(self) -> None:
        """
        Tests that an empty body parses to None.
        """
        # GIVEN an empty body
        # WHEN it is parsed
        # THEN it returns None
        self.assertIsNone(_parse_openai_streaming("fireworks", b""))


class OpenAICompatibleDispatchTests(unittest.TestCase):
    def test_routes_event_stream_content_type_to_streaming_parser(self) -> None:
        """
        Tests that a text/event-stream response routes to the streaming parser.
        """
        # GIVEN a Fireworks streaming response and its event-stream content type
        # WHEN the top-level entry point parses it
        record = parse_openai_chat_completions_response(
            provider="fireworks",
            request_path="/inference/v1/chat/completions",
            request_body=OPENAI_STREAMING_REQUEST_BODY,
            response_content_type="text/event-stream; charset=utf-8",
            response_body=_openai_streaming_response(),
        )

        # THEN the streaming usage totals are recovered
        assert record is not None
        self.assertEqual(record["output_tokens"], 800)

    def test_routes_application_json_content_type_to_non_streaming_parser(
        self,
    ) -> None:
        """
        Tests that an application/json response routes to the JSON parser.
        """
        # GIVEN an OpenAI non-streaming response and its json content type
        # WHEN the top-level entry point parses it
        record = parse_openai_chat_completions_response(
            provider="openai",
            request_path="/v1/chat/completions",
            request_body=OPENAI_NON_STREAMING_REQUEST_BODY,
            response_content_type="application/json",
            response_body=_openai_non_streaming_response(),
        )

        # THEN the non-streaming usage totals are recovered under the provider
        assert record is not None
        self.assertEqual(record["output_tokens"], 567)
        self.assertEqual(record["provider"], "openai")

    def test_falls_back_to_request_body_stream_flag_when_content_type_is_missing(
        self,
    ) -> None:
        """
        Tests that a missing content type falls back to the request `stream` flag.
        """
        # GIVEN a streaming response with no content-type header
        # WHEN the top-level entry point parses it
        record = parse_openai_chat_completions_response(
            provider="fireworks",
            request_path="/inference/v1/chat/completions",
            request_body=OPENAI_STREAMING_REQUEST_BODY,
            response_content_type="",
            response_body=_openai_streaming_response(),
        )

        # THEN the stream flag selects the streaming parser
        assert record is not None
        self.assertEqual(record["output_tokens"], 800)

    def test_skips_non_chat_completions_paths(self) -> None:
        """
        Tests that endpoints other than /chat/completions return no record.
        """
        # GIVEN an embeddings request path that carries no chat usage
        # WHEN the top-level entry point parses it
        # THEN it returns None
        self.assertIsNone(
            parse_openai_chat_completions_response(
                provider="openai",
                request_path="/v1/embeddings",
                request_body=b"",
                response_content_type="application/json",
                response_body=b'{"data":[]}',
            )
        )

    def test_ignores_query_string_on_chat_completions_path(self) -> None:
        """
        Tests that a query string does not defeat the /chat/completions match.
        """
        # GIVEN a chat-completions path with a trailing query string
        # WHEN the top-level entry point parses it
        record = parse_openai_chat_completions_response(
            provider="fireworks",
            request_path="/inference/v1/chat/completions?foo=bar",
            request_body=OPENAI_NON_STREAMING_REQUEST_BODY,
            response_content_type="application/json",
            response_body=_openai_non_streaming_response(),
        )

        # THEN the record is still produced
        assert record is not None
        self.assertEqual(record["output_tokens"], 567)


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

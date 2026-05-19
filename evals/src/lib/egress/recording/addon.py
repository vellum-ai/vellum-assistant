"""
mitmproxy addon that records per-request LLM cost from Anthropic responses.

Loaded with `mitmdump --scripts /opt/recording/addon.py`. Wires the
mitmproxy `response` hook into the pure-function parser
(`usage_parser.parse_anthropic_messages_response`) and appends each
parsed usage record as one NDJSON line to `RECORDING_OUTPUT_PATH`
(default `/recording/egress-usage.ndjson`).

Two hosts get intercepted for parsing:
- `api.anthropic.com` (the only provider parsed in v1)

Other allowlisted hosts (OpenAI, Gemini) flow through mitmproxy and out
the egress jail just like before — the recording addon doesn't touch
their bodies. Follow-up tickets will add per-provider parsers as needed.

Design notes:
- Bodies are accumulated by mitmproxy. For SSE streaming we let
  mitmproxy buffer the full response before the `response` hook fires;
  this is fine for evals (we're not consuming the stream — the
  assistant container is — and mitmproxy's response_streaming=False
  default gives us a complete body). Latency overhead is bounded by the
  longest single Anthropic response.
- Errors during parsing are swallowed and logged via ctx.log so a
  single bad response can never crash the proxy and bring the whole
  evals run down.
- Output is fsync'd after each write so a hard kill of the mitmproxy
  container (eval run cleanup) still leaves a usable NDJSON file.
"""

from __future__ import annotations

import json
import os
import sys
import threading
from datetime import datetime, timezone
from typing import Optional

# `mitmdump` adds the script's directory to sys.path so `import
# usage_parser` resolves to the sibling file.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import usage_parser  # noqa: E402

try:
    from mitmproxy import ctx, http  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover -- only hit outside mitmproxy
    ctx = None  # type: ignore[assignment]
    http = None  # type: ignore[assignment]


RECORDING_OUTPUT_PATH = os.environ.get(
    "RECORDING_OUTPUT_PATH", "/recording/egress-usage.ndjson"
)

# Lock guards the NDJSON file writer — mitmproxy can fire `response`
# hooks concurrently for parallel requests.
_write_lock = threading.Lock()


def _log_info(message: str) -> None:
    if ctx is not None:
        ctx.log.info(message)
    else:  # pragma: no cover
        print(message)


def _log_warn(message: str) -> None:
    if ctx is not None:
        ctx.log.warn(message)
    else:  # pragma: no cover
        print("WARN:", message, file=sys.stderr)


def _append_ndjson(record: dict) -> None:
    line = json.dumps(record, separators=(",", ":"))
    with _write_lock:
        try:
            with open(RECORDING_OUTPUT_PATH, "a", encoding="utf-8") as fh:
                fh.write(line + "\n")
                fh.flush()
                os.fsync(fh.fileno())
        except OSError as err:
            _log_warn(f"recording: failed to append usage record: {err}")


def response(flow) -> None:  # type: ignore[no-untyped-def]
    """mitmproxy hook fired after the full response body is available."""
    try:
        request = flow.request
        response = flow.response
        host = (request.pretty_host or "").lower()
        if host != "api.anthropic.com":
            return
        request_body: bytes = request.raw_content or b""
        response_body: bytes = response.raw_content or b""
        content_type = response.headers.get("content-type", "")
        record: Optional[dict] = usage_parser.parse_anthropic_messages_response(
            request_path=request.path,
            request_body=request_body,
            response_content_type=content_type,
            response_body=response_body,
        )
        if record is None:
            return
        record["recorded_at"] = datetime.now(timezone.utc).isoformat()
        record["request_path"] = request.path
        record["status_code"] = response.status_code
        _append_ndjson(record)
        _log_info(
            f"recording: anthropic usage {record.get('input_tokens')}/"
            f"{record.get('output_tokens')} tokens "
            f"({record.get('model', '?')})"
        )
    except Exception as err:  # noqa: BLE001 -- never crash mitmproxy
        _log_warn(f"recording: hook raised {type(err).__name__}: {err}")

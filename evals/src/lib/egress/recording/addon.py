"""
mitmproxy addon. Two responsibilities:

  1. **Recording.** Wires the `response` hook into the pure-function
     parser (`usage_parser.parse_anthropic_messages_response`) and
     appends each parsed Anthropic usage record as one NDJSON line to
     `RECORDING_OUTPUT_PATH` (default `/recording/egress-usage.ndjson`).
  2. **Mocking.** Wires the `request` hook into the pure-function
     mock-github handler (`mock_github_handler.handle`). When the
     handler returns a synthesized response, the addon short-circuits
     the request with `flow.response = http.Response.make(...)`, so
     mitmproxy never makes an upstream call for it. This lets us catch
     `assistant plugins install` traffic at the egress jail and serve
     plugins from a fixtures directory bind-mounted into the sidecar,
     instead of allowing api.github.com / raw.githubusercontent.com
     through the iptables allowlist.

Hosts intercepted for response parsing:
  - `api.anthropic.com` (the only provider parsed in v1)

Hosts intercepted for request mocking (when `PLUGIN_FIXTURES_DIR` is
set):
  - `api.github.com` — plugin Contents API listings
  - `raw.githubusercontent.com` — plugin file downloads

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
# usage_parser` + `import mock_github_handler` resolve to the sibling
# files.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import mock_github_handler  # noqa: E402
import usage_parser  # noqa: E402

try:
    from mitmproxy import ctx, http  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover -- only hit outside mitmproxy
    ctx = None  # type: ignore[assignment]
    http = None  # type: ignore[assignment]


RECORDING_OUTPUT_PATH = os.environ.get(
    "RECORDING_OUTPUT_PATH", "/recording/egress-usage.ndjson"
)

# When set, the request hook serves plugin install traffic from this
# directory instead of letting it egress. Unset = mocking disabled,
# requests fall through to the iptables DROP-default policy.
PLUGIN_FIXTURES_DIR: Optional[str] = os.environ.get("PLUGIN_FIXTURES_DIR")

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


def request(flow) -> None:  # type: ignore[no-untyped-def]
    """mitmproxy hook fired before mitmproxy makes the upstream request.

    Dispatches to `mock_github_handler.handle`. On a match the handler
    returns a `(status, content_type, body)` tuple; we set
    `flow.response` inline so mitmproxy short-circuits and never makes
    the upstream call. On a miss the handler returns `None` and the
    request flows through to the response hook + addon's normal
    upstream re-emission.

    Disabled when `PLUGIN_FIXTURES_DIR` is unset (no fixtures dir
    bind-mounted) — every request falls through to the upstream path.
    Errors are swallowed via the same ctx.log pattern as the response
    hook so a single bad request can never crash mitmproxy.
    """
    if http is None or PLUGIN_FIXTURES_DIR is None:
        return
    try:
        request = flow.request
        method = request.method
        # `--showhost` in entrypoint.sh makes `pretty_host` use the
        # original Host header from the client, so we reconstruct the
        # same URL the assistant CLI dialed before the iptables
        # REDIRECT bounced it into mitmproxy.
        url = f"https://{request.pretty_host}{request.path}"
        result = mock_github_handler.handle(
            method=method,
            url=url,
            fixtures_dir=PLUGIN_FIXTURES_DIR,
        )
        if result is None:
            return
        status, content_type, body = result
        flow.response = http.Response.make(
            status,
            body,
            {
                "content-type": content_type,
                "x-mocked-by": "vellum-evals-egress-mock",
            },
        )
        _log_info(
            f"mock_github: {method} {url} -> {status} ({len(body)} bytes)"
        )
    except Exception as err:  # noqa: BLE001 -- never crash mitmproxy
        _log_warn(f"mock_github: hook raised {type(err).__name__}: {err}")


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

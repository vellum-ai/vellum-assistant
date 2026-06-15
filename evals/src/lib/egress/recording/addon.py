"""
mitmproxy addon. Two responsibilities:

  1. **Recording.** Wires the `response` hook into the pure-function
     usage parsers (`usage_parser.parse_*`) and appends each parsed
     usage record as one NDJSON line to `RECORDING_OUTPUT_PATH`
     (default `/recording/egress-usage.ndjson`). Anthropic
     `/v1/messages` and OpenAI-compatible `/chat/completions` (OpenAI,
     Fireworks) traffic are parsed; every record carries a `provider`
     field so the report can key pricing on `<provider>:<model>`.
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
  - `api.anthropic.com` — Anthropic `/v1/messages`
  - `api.openai.com` — OpenAI `/chat/completions`
  - `api.fireworks.ai` — Fireworks `/inference/v1/chat/completions`
    (open-weight models, e.g. the `vellum-minimax` profile's MiniMax-M3)

Hosts intercepted for request mocking (when `PLUGIN_FIXTURES_DIR` is
set):
  - `api.github.com` — plugin Contents API listings
  - `raw.githubusercontent.com` — plugin file downloads

Other allowlisted model hosts flow through mitmproxy and out the egress
jail untouched — the addon only parses hosts whose wire format it
understands. Gemini (`generativelanguage.googleapis.com`) uses a
distinct API shape and is not metered, so its runs score $0 on the cost
metric until a parser for it is added.

Design notes:
- Bodies are accumulated by mitmproxy. For SSE streaming we let
  mitmproxy buffer the full response before the `response` hook fires;
  this is fine for evals (we're not consuming the stream — the
  assistant container is — and mitmproxy's response_streaming=False
  default gives us a complete body). Latency overhead is bounded by the
  longest single model response.
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

# Upper bound on the request/response payload text stored per usage record.
# The report inlines these so a reviewer can see exactly what each priced
# request sent and received — invaluable when the cost figure looks wrong.
# Capped so a large SSE completion can't bloat `egress-usage.ndjson` (and
# therefore the static report bundle) without bound; the full byte length
# is always recorded alongside so the report can flag truncation.
MAX_PAYLOAD_CHARS = int(os.environ.get("RECORDING_MAX_PAYLOAD_CHARS", "32768"))

# When set, the request hook serves plugin install traffic from this
# directory instead of letting it egress. Unset = mocking disabled,
# requests fall through to the iptables DROP-default policy.
PLUGIN_FIXTURES_DIR: Optional[str] = os.environ.get("PLUGIN_FIXTURES_DIR")

# Hosts whose responses speak the OpenAI chat-completions wire format,
# mapped to the provider label stamped onto each usage record. OpenAI and
# Fireworks share an identical request/response shape, so one parser
# serves both; only the observed host distinguishes the provider for
# pricing (`<provider>:<model>` in `src/lib/pricing.ts`).
OPENAI_COMPATIBLE_HOSTS = {
    "api.openai.com": "openai",
    "api.fireworks.ai": "fireworks",
}

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


def _decoded_body(message) -> bytes:  # type: ignore[no-untyped-def]
    """Return an HTTP message body with any `Content-Encoding` removed.

    mitmproxy's `content` property transparently decodes gzip/deflate/br/zstd;
    `raw_content` is the compressed wire bytes. The usage parser reads JSON and
    SSE text, so it needs the decoded body. If decoding raises (e.g. a
    malformed encoding header), fall back to the raw bytes rather than dropping
    the record outright.
    """
    try:
        return message.content or b""
    except Exception:  # noqa: BLE001 -- decode failure: fall back to raw bytes
        return message.raw_content or b""


def _payload_fields(prefix: str, body: bytes) -> dict:
    """Build the inlined-payload fields for one HTTP message body.

    Returns `{<prefix>_body, <prefix>_body_bytes, <prefix>_body_truncated}`.
    The body is decoded as UTF-8 (replacing undecodable bytes) and capped at
    `MAX_PAYLOAD_CHARS`; the full byte length is preserved so the report can
    show "showing first N of M bytes" when the text was truncated.
    """
    full_bytes = len(body)
    text = body.decode("utf-8", errors="replace")
    truncated = len(text) > MAX_PAYLOAD_CHARS
    return {
        f"{prefix}_body": text[:MAX_PAYLOAD_CHARS],
        f"{prefix}_body_bytes": full_bytes,
        f"{prefix}_body_truncated": truncated,
    }


def response(flow) -> None:  # type: ignore[no-untyped-def]
    """mitmproxy hook fired after the full response body is available."""
    try:
        request = flow.request
        response = flow.response
        host = (request.pretty_host or "").lower()
        if host != "api.anthropic.com" and host not in OPENAI_COMPATIBLE_HOSTS:
            return
        # Use the content-decoded body, not `raw_content`. The model SDKs
        # negotiate `Accept-Encoding: gzip` (and brotli/zstd when those libs
        # are present), so the on-the-wire `raw_content` is compressed and the
        # JSON / SSE parser would always fail to read it. mitmproxy's `content`
        # accessor strips the `Content-Encoding`; we fall back to `raw_content`
        # only if decoding itself raises (malformed encoding header).
        # https://docs.mitmproxy.org/stable/api/mitmproxy/http.html#Message.content
        request_body = _decoded_body(request)
        response_body = _decoded_body(response)
        content_type = response.headers.get("content-type", "")
        if host == "api.anthropic.com":
            record: Optional[dict] = (
                usage_parser.parse_anthropic_messages_response(
                    request_path=request.path,
                    request_body=request_body,
                    response_content_type=content_type,
                    response_body=response_body,
                )
            )
        else:
            record = usage_parser.parse_openai_chat_completions_response(
                provider=OPENAI_COMPATIBLE_HOSTS[host],
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
        record.update(_payload_fields("request", request_body))
        record.update(_payload_fields("response", response_body))
        _append_ndjson(record)
        _log_info(
            f"recording: {record.get('provider', '?')} usage "
            f"{record.get('input_tokens')}/"
            f"{record.get('output_tokens')} tokens "
            f"({record.get('model', '?')})"
        )
    except Exception as err:  # noqa: BLE001 -- never crash mitmproxy
        _log_warn(f"recording: hook raised {type(err).__name__}: {err}")

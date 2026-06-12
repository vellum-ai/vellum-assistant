"""
mitmproxy addon. Three responsibilities:

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
     out to the real GitHub.
  3. **Allowlist enforcement.** Also in the `request` hook, after the
     mock handler has had its chance: any request whose `pretty_host`
     is not in `ALLOW_HOSTS` (and was not satisfied by a mock) is
     short-circuited with a 403. This is the jail's primary egress
     control now — it replaces the per-IP iptables ACCEPT rules that
     `apply-recording-jail.sh` used to install from a one-shot DNS
     resolution. Those broke under DNS rotation: api.anthropic.com
     rotates IPs with low TTLs, so a fresh IP minutes into a run had
     no matching ACCEPT and mitmproxy's upstream connect hit the
     default DROP. Enforcing by hostname at the proxy is rotation-proof
     — mitmproxy is free to dial whatever IP DNS returns, and the
     allowlist decision is made on the stable Host header instead.

Hosts intercepted for response parsing:
  - `api.anthropic.com` (the only provider parsed in v1)

Hosts intercepted for request mocking (when `PLUGIN_FIXTURES_DIR` is
set):
  - `api.github.com` — plugin Contents API listings
  - `raw.githubusercontent.com` — plugin file downloads

ALL TLS/443 flows are intercepted now (entrypoint.sh no longer passes
`--allow-hosts` to mitmdump). That is safe because only the assistant
container trusts the mitmproxy CA; the gateway / credential-executor
containers don't share this netns, so their traffic never reaches us.
Other allowlisted hosts (OpenAI, Gemini, the platform) flow through
mitmproxy and out the egress jail — the recording addon doesn't touch
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

# Upper bound on the request/response payload text stored per usage record.
# The report inlines these so a reviewer can see exactly what each priced
# request sent and received — invaluable when the cost figure looks wrong.
# Capped so a large SSE completion can't bloat `egress-usage.ndjson` (and
# therefore the static report bundle) without bound; the full byte length
# is always recorded alongside so the report can flag truncation.
MAX_PAYLOAD_CHARS = int(os.environ.get("RECORDING_MAX_PAYLOAD_CHARS", "32768"))

# When set, the request hook serves plugin install traffic from this
# directory instead of letting it egress. Unset = mocking disabled,
# requests fall through to the allowlist check (and out, if allowed).
PLUGIN_FIXTURES_DIR: Optional[str] = os.environ.get("PLUGIN_FIXTURES_DIR")


def _parse_allow_hosts(raw: Optional[str]) -> frozenset:
    """Parse the comma-separated ALLOW_HOSTS env var into a lowercase set.

    Hosts are compared case-insensitively (DNS is case-insensitive and
    `pretty_host` can echo whatever case the client sent), so we
    normalize both the allowlist and the request host to lowercase.
    Blank entries and surrounding whitespace are stripped so a trailing
    comma or a `"a, b"` style value parses cleanly.
    """
    if not raw:
        return frozenset()
    return frozenset(
        host.strip().lower() for host in raw.split(",") if host.strip()
    )


# Hostname allowlist enforced in the `request` hook. Parsed once at
# module load — ALLOW_HOSTS is fixed for the lifetime of the sidecar.
ALLOW_HOSTS: frozenset = _parse_allow_hosts(os.environ.get("ALLOW_HOSTS"))

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

    Two stages, in order:

      1. **Mock.** When `PLUGIN_FIXTURES_DIR` is set, dispatch to
         `mock_github_handler.handle`. On a match the handler returns a
         `(status, content_type, body)` tuple; we set `flow.response`
         inline so mitmproxy short-circuits and never makes the upstream
         call, and we return immediately (a mocked request is allowed by
         construction — it never egresses).

      2. **Allowlist.** If the request wasn't mocked, enforce the
         hostname allowlist: when `request.pretty_host` is not in
         `ALLOW_HOSTS` (case-insensitive exact match), short-circuit
         with a 403 so mitmproxy never makes the upstream call. Allowed
         hosts fall through to the response hook + normal upstream
         re-emission.

    This is the jail's egress control. Mock-then-allowlist ordering
    matters: GitHub hosts are intentionally NOT in `ALLOW_HOSTS` (they're
    served from disk), so the mock has to win before the allowlist would
    403 them.

    Errors are swallowed via the same ctx.log pattern as the response
    hook so a single bad request can never crash mitmproxy. On an
    unexpected error we fail OPEN (let the request through) rather than
    risk wedging a whole eval run — the iptables DROP-default + per-flow
    REDIRECT still backstops any truly non-allowlisted path, and a
    non-CA-trusting client's handshake fails regardless.
    """
    if http is None:
        return
    try:
        request = flow.request
        method = request.method
        host = (request.pretty_host or "").lower()
        # `--showhost` in entrypoint.sh makes `pretty_host` use the
        # original Host header from the client, so we reconstruct the
        # same URL the assistant CLI dialed before the iptables
        # REDIRECT bounced it into mitmproxy.
        url = f"https://{request.pretty_host}{request.path}"

        # Stage 1: mock (only when a fixtures dir is bind-mounted).
        if PLUGIN_FIXTURES_DIR is not None:
            result = mock_github_handler.handle(
                method=method,
                url=url,
                fixtures_dir=PLUGIN_FIXTURES_DIR,
            )
            if result is not None:
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
                    f"mock_github: {method} {url} -> {status} "
                    f"({len(body)} bytes)"
                )
                return

        # Stage 2: hostname allowlist. A request that reaches here was
        # not mocked; block it unless its host is explicitly allowed.
        if host not in ALLOW_HOSTS:
            flow.response = http.Response.make(
                403,
                b"blocked by vellum-evals egress jail: host not in allowlist\n",
                {"content-type": "text/plain; charset=utf-8"},
            )
            _log_info(
                f"egress-jail: blocked {method} {url} "
                f"(host {host!r} not in allowlist)"
            )
            return
    except Exception as err:  # noqa: BLE001 -- never crash mitmproxy
        _log_warn(f"request: hook raised {type(err).__name__}: {err}")


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
        if host != "api.anthropic.com":
            return
        # Use the content-decoded body, not `raw_content`. The Anthropic SDK
        # negotiates `Accept-Encoding: gzip` (and brotli/zstd when those libs
        # are present), so the on-the-wire `raw_content` is compressed and the
        # JSON / SSE parser would always fail to read it. mitmproxy's `content`
        # accessor strips the `Content-Encoding`; we fall back to `raw_content`
        # only if decoding itself raises (malformed encoding header).
        # https://docs.mitmproxy.org/stable/api/mitmproxy/http.html#Message.content
        request_body = _decoded_body(request)
        response_body = _decoded_body(response)
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
        record.update(_payload_fields("request", request_body))
        record.update(_payload_fields("response", response_body))
        _append_ndjson(record)
        _log_info(
            f"recording: anthropic usage {record.get('input_tokens')}/"
            f"{record.get('output_tokens')} tokens "
            f"({record.get('model', '?')})"
        )
    except Exception as err:  # noqa: BLE001 -- never crash mitmproxy
        _log_warn(f"recording: hook raised {type(err).__name__}: {err}")

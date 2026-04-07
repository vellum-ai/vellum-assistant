# @vellum/chrome-extension-native-host

A tiny Node CLI binary that bridges the Vellum Chrome extension and the
locally-running Vellum assistant via [Chrome Native Messaging][cnm]. It
exists so the extension can bootstrap a scoped capability token for the
self-hosted (local-daemon) transport without ever shipping a long-lived
secret in the extension package itself.

This package is **scaffolding only** in this PR. It is not yet wired into
the extension or the macOS installer — those land in PR 12 (manifest +
installer) and PR 13 (extension self-hosted bootstrap flow). The runtime
HTTP endpoint it talks to (`/v1/browser-extension-pair`) lands in PR 11.

[cnm]: https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging

## Why a separate binary?

Chrome only allows extensions to talk to native code through the native
messaging protocol: a stdio pipe with a 4-byte little-endian length prefix
and a UTF-8 JSON body. The host binary is registered with Chrome via a
JSON manifest installed in a well-known location, and Chrome enforces an
allowlist of extension IDs in that manifest before it will spawn the
binary at all.

Keeping the helper as its own package gives us:

- A clean security boundary: the helper has zero imports from the
  extension or the assistant daemon, and verifies the calling extension
  ID against a hard-coded allowlist before doing any work.
- A small, auditable surface: ~200 lines of TypeScript that compile to a
  single Node CLI entry point.
- Simple distribution: the macOS installer (PR 12) just drops the
  compiled `dist/index.js` and a manifest into `~/Library/Application
  Support/Google/Chrome/NativeMessagingHosts/`.

## Stdio contract

The helper speaks a single request/response exchange per spawn. Chrome
re-spawns it on every `chrome.runtime.connectNative("com.vellum.daemon")`
call, so there is no long-lived session state.

### Frame format

Every message in either direction is framed as:

```
+--------+----------------------------+
| u32 LE |   UTF-8 JSON (len bytes)   |
| length |                            |
+--------+----------------------------+
```

`encodeFrame(payload)` and `decodeFrames(buf)` in `src/protocol.ts` are
the canonical implementations. They are pure functions — no I/O — and are
covered by `src/__tests__/protocol.test.ts`.

### Messages

The extension sends:

```json
{ "type": "request_token" }
```

On success, the helper writes:

```json
{
  "type": "token_response",
  "token": "<scoped capability token>",
  "expiresAt": "<ISO-8601 timestamp>"
}
```

On any failure, the helper writes:

```json
{ "type": "error", "message": "<reason>" }
```

…and exits with a non-zero status code. Possible `message` values
include `unauthorized_origin`, `unsupported_frame_type`,
`unexpected_additional_frame`, and any error string surfaced by the
underlying `fetch` to the daemon (`failed to reach daemon at …`,
`daemon pair request failed with HTTP 503`, etc.).

## Origin allowlist

Chrome appends the calling extension's origin (e.g.
`chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/`) as the first
positional argument when launching the host. The helper parses this,
extracts the bare extension ID, and rejects anything not in
`ALLOWED_EXTENSION_IDS` in `src/index.ts` before reading any stdin
bytes.

Today the allowlist contains a single dev placeholder ID. The production
ID will be added before release — see the `// TODO: production id before
release` comment in `src/index.ts`.

## Daemon port resolution

The helper looks up the daemon's HTTP port by reading
`~/.vellum/runtime-port` (a single integer written by the assistant on
startup). If the file is missing, unreadable, or doesn't contain a valid
port number, it falls back to the well-known default port `7821`. The
subsequent HTTP request will surface a clear connection error if the
daemon isn't actually listening there.

## Building

```bash
cd clients/chrome-extension-native-host
bun install
bun run build       # produces dist/index.js
```

`bun run build` is a thin wrapper around `tsc -p tsconfig.json`. The
output is a single ES module file under `dist/` that can be invoked
directly with `node dist/index.js`.

## Testing

```bash
cd clients/chrome-extension-native-host
bun test src/__tests__/protocol.test.ts
```

The current test suite covers the framing protocol (round-trips,
multi-frame buffers, partial frames, empty buffers). The CLI itself does
not yet have integration tests — those land alongside PR 13 when the
extension-side bootstrap flow is wired up.

## Local manual smoke test

Once the daemon is running and exposing `/v1/browser-extension-pair`
(PR 11), you can exercise the helper end-to-end without Chrome by piping
a framed request to it on stdin. Add the extension ID you want to test
to `ALLOWED_EXTENSION_IDS` in `src/index.ts` (or use the existing dev
placeholder), then:

```bash
node -e "
  const { encodeFrame } = require('./dist/protocol.js');
  process.stdout.write(encodeFrame({ type: 'request_token' }));
" | node dist/index.js "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"
```

The helper will write a single `token_response` frame to stdout and
exit `0`, or an `error` frame and exit `1`.

## Related PRs

- **PR 11** — Daemon `/v1/browser-extension-pair` endpoint that mints
  the capability token this helper requests.
- **PR 12** — macOS installer changes that drop the compiled binary and
  the native messaging host manifest into Chrome's well-known
  `NativeMessagingHosts` directory.
- **PR 13** — Chrome extension changes that call
  `chrome.runtime.connectNative("com.vellum.daemon")`, send a
  `request_token` frame, and persist the response in
  `chrome.storage.local`.

# @vellum/chrome-extension-native-host

A tiny Node CLI binary that bridges the Vellum Chrome extension and the
locally-running Vellum assistant via [Chrome Native Messaging][cnm]. It
exists so the extension can bootstrap a scoped capability token for the
self-hosted (local-assistant) transport without ever shipping a long-lived
secret in the extension package itself.

The macOS installer wiring landed in PR 12: the helper is now bundled
into the Mac `.app` under `Contents/MacOS/vellum-chrome-native-host`
via `clients/macos/build.sh` (see the "Bundling into the macOS app"
section below), and `NativeMessagingInstaller` writes the
`com.vellum.daemon.json` manifest into Chrome's per-user
`NativeMessagingHosts` directory at launch time. The extension-side
bootstrap flow that actually spawns this helper lands in PR 13, and the
runtime HTTP endpoint it talks to (`/v1/browser-extension-pair`) lands
in PR 11.

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
  extension or the assistant, and verifies the calling extension
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
`unexpected_additional_frame`, `protocol_error: malformed_frame_json: …`
(returned when stdin contains a frame whose body is not valid JSON), and
any error string surfaced by the underlying `fetch` to the assistant
(`failed to reach assistant at …`, `assistant pair request failed with
HTTP 503`, etc.). Per the project-wide terminology rule in `AGENTS.md`,
all user-visible strings refer to the local process as the "assistant".

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

## Assistant port resolution

The helper looks up the assistant's HTTP port using the following
precedence (highest first):

1. **`--assistant-port <port>`** CLI flag — accepts either
   `--assistant-port 7822` or `--assistant-port=7822`. This exists so a
   wrapper script registered in Chrome's `NativeMessagingHosts` manifest
   can pin the helper to a known port for non-default installs (e.g.
   named local instances spawned by `cli/src/lib/local.ts` which set
   `RUNTIME_HTTP_PORT` from `resources.daemonPort`).
2. **`~/.vellum/runtime-port`** lockfile — a single integer written by
   the assistant on startup. *Note: this lockfile is not yet written by
   the assistant — see the TODO below.* Once it is, default installs
   will not need any manifest-side configuration.
3. **`7821`** — the well-known default port.

If a step fails (file missing, parse error, etc.), resolution falls
through to the next step. The subsequent HTTP request will surface a
clear connection error if the assistant isn't actually listening on the
resolved port.

> **TODO (follow-up):** Have the assistant write its active HTTP port
> to `~/.vellum/runtime-port` on startup so the lockfile branch above
> starts working without requiring `--assistant-port`. This was
> intentionally left out of the scaffold PR (PR 7) to keep the change
> surface small. Until then, multi-instance installs should rely on the
> CLI flag via a wrapper script in the native messaging manifest.

## Building

```bash
cd clients/chrome-extension-native-host
bun install
bun run build       # produces dist/index.js
```

`bun run build` is a thin wrapper around `tsc -p tsconfig.json`. The
output is a single ES module file under `dist/` that can be invoked
directly with `node dist/index.js`. This form is convenient for local
development and unit tests.

## Bundling into the macOS app

The production macOS `.app` does **not** ship the `dist/index.js` form
— Chrome's native messaging `path` field must point at a runnable
executable, and we do not want to assume that the user has `node` on
their `$PATH`. Instead, `clients/macos/build.sh` uses
`bun build --compile` (via its shared `build_bun_binary` helper) to
produce a self-contained single-file binary named
`vellum-chrome-native-host`, writes it to
`$SCRIPT_DIR/native-host-bin/`, and then copies it into the app bundle
at `Contents/MacOS/vellum-chrome-native-host` alongside the other
compiled Bun binaries (`vellum-daemon`, `vellum-cli`,
`vellum-gateway`, `vellum-assistant`).

At first launch, the Swift-side `NativeMessagingInstaller` (see
`clients/macos/vellum-assistant/Features/Installer/NativeMessagingInstaller.swift`)
resolves the bundled binary via
`Bundle.main.url(forAuxiliaryExecutable: "vellum-chrome-native-host")`
and writes `com.vellum.daemon.json` pointing `path` at that absolute
location. Because the manifest is regenerated on every launch, moving
or upgrading the `.app` bundle automatically repoints Chrome at the
new helper location without a manual re-pair step.

### Why Bun single-file compile (not `node dist/index.js`)

The plan initially considered shipping `dist/index.js` plus a wrapper
shell script. That approach was dropped because:

1. Chrome's native messaging host `path` must be executable — it does
   not support shell interpretation of script shebangs beyond the OS's
   own `execve`, which means we would still need a compiled wrapper.
2. Every other binary the macOS app ships (daemon, CLI, gateway) uses
   `bun build --compile` into a native single-file binary. Reusing
   that same pipeline keeps the build/signing steps uniform and avoids
   depending on the user having `node` installed.
3. The compiled binary participates in the app's codesign chain and
   notarization pipeline the same way as the other helpers, which
   keeps macOS Gatekeeper happy.

### Manifest template

The canonical manifest shape is checked in at
`clients/chrome-extension-native-host/com.vellum.daemon.json.template`.
`NativeMessagingInstaller` rebuilds the same structure in-memory via
`JSONSerialization` and overwrites the on-disk file on every launch
(idempotent) so that upgrading the app bundle automatically updates the
`path` and `allowed_origins` entries. The `__HELPER_BINARY_PATH__` and
`__VELLUM_EXTENSION_ID__` placeholders in the template are for
humans reading the checked-in file — the actual install never
performs template substitution.

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

Once the assistant is running and exposing `/v1/browser-extension-pair`
(PR 11), you can exercise the helper end-to-end without Chrome by piping
a framed request to it on stdin. Add the extension ID you want to test
to `ALLOWED_EXTENSION_IDS` in `src/index.ts` (or use the existing dev
placeholder), then:

```bash
node --input-type=module -e "
  import { encodeFrame } from './dist/protocol.js';
  process.stdout.write(encodeFrame({ type: 'request_token' }));
" | node dist/index.js "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"
```

(The package is ESM — `"type": "module"` in `package.json` — so the
inline snippet uses `--input-type=module` and dynamic `import()` rather
than `require()`, which would fail with `ERR_REQUIRE_ESM`.)

The helper will write a single `token_response` frame to stdout and
exit `0`, or an `error` frame and exit `1`.

To target a non-default assistant port (e.g. a named local instance):

```bash
node --input-type=module -e "
  import { encodeFrame } from './dist/protocol.js';
  process.stdout.write(encodeFrame({ type: 'request_token' }));
" | node dist/index.js \
    "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/" \
    --assistant-port 7822
```

## Related PRs

- **PR 11** — Assistant `/v1/browser-extension-pair` endpoint that mints
  the capability token this helper requests.
- **PR 12** — macOS installer changes that drop the compiled binary and
  the native messaging host manifest into Chrome's well-known
  `NativeMessagingHosts` directory.
- **PR 13** — Chrome extension changes that call
  `chrome.runtime.connectNative("com.vellum.daemon")`, send a
  `request_token` frame, and persist the response in
  `chrome.storage.local`.

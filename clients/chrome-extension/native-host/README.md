# @vellum/chrome-extension-native-host

A tiny Node CLI binary that bridges the Vellum Chrome extension and the
locally-running Vellum assistant via [Chrome Native Messaging][cnm]. It
serves two purposes:

1. **Assistant discovery** (`list_assistants`): reads the lockfile and
   returns the full assistant catalog so the extension can populate its
   assistant selector dropdown.
2. **Self-hosted pairing** (`request_token`): bootstraps a scoped
   capability token for the local-assistant transport without shipping a
   long-lived secret in the extension package.

### Automatic maintenance path (normal operation)

In the shipped seamless-extension architecture, native pairing is an
**automatic maintenance operation** — not a user-initiated step. The
extension's service worker invokes `request_token` silently in two
scenarios:

- **First connect**: When the user clicks Connect for the first time, the
  worker auto-bootstraps the local capability token via native messaging
  as part of the one-click flow. No separate "Pair" action is needed.
- **Silent token refresh**: When a stored token is expired or stale (at
  connect time, reconnect time, or auto-connect on browser reopen), the
  worker attempts a non-interactive `bootstrapLocalToken()` call that
  re-invokes the native helper under the hood. If the assistant is
  reachable, the token is refreshed silently and the relay reconnects
  without user involvement.

### Manual invocation (diagnostics only)

The popup's Troubleshooting section includes a "Re-pair with local
assistant" button that also invokes `request_token`. This is reserved for
cases where automatic recovery has failed — e.g. the native messaging
host was uninstalled, the assistant was unreachable during all automatic
refresh attempts, or the pair endpoint rejected the extension origin. The
popup only surfaces this control when the health state is `auth_required`
or `error`; during normal `connected` or `reconnecting` states the
Troubleshooting section stays collapsed.

### Bundling

The macOS installer bundles this helper into the Mac `.app` under
`Contents/MacOS/vellum-chrome-native-host` via `clients/macos/build.sh`
(see the "Bundling into the macOS app" section below), and
`NativeMessagingInstaller` writes the `com.vellum.daemon.json` manifest
into Chrome's per-user `NativeMessagingHosts` directory at launch time.

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
- Simple distribution: the macOS installer just drops the
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
the canonical implementations. They are pure functions -- no I/O -- and are
covered by `src/__tests__/protocol.test.ts`.

### Messages

#### Assistant catalog (`list_assistants`)

The extension sends:

```json
{ "type": "list_assistants" }
```

On success, the helper reads the lockfile and writes:

```json
{
  "type": "assistants_response",
  "assistants": [
    {
      "assistantId": "<id>",
      "cloud": "local",
      "runtimeUrl": "http://127.0.0.1:7831",
      "daemonPort": 7821,
      "isActive": true
    }
  ],
  "activeAssistantId": "<id-of-active-assistant-or-null>"
}
```

Each entry in the `assistants` array corresponds to an assistant in the
lockfile. The extension maps the `cloud` field to an auth profile
(`local-pair`, `cloud-oauth`, or `unsupported`) via
`assistant-auth-profile.ts`. When the `assistantId` is supplied alongside
a `request_token` frame, the helper pairs against the specified
assistant's port rather than the default.

#### Self-hosted pairing (`request_token`)

During normal operation, the extension's service worker sends this message
automatically as part of the one-click Connect flow when the selected
assistant uses the `local-pair` auth profile. Users do not interact with
this message directly. It is also invoked when the user clicks the
"Re-pair with local assistant" troubleshooting button in the popup.

The extension sends:

```json
{ "type": "request_token" }
```

Optionally with an `assistantId` to target a specific assistant:

```json
{ "type": "request_token", "assistantId": "<id>" }
```

On success, the helper writes:

```json
{
  "type": "token_response",
  "token": "<scoped capability token>",
  "expiresAt": "<ISO-8601 timestamp>"
}
```

#### Error responses

On any failure, the helper writes:

```json
{ "type": "error", "message": "<reason>" }
```

...and exits with a non-zero status code. Possible `message` values
include `unauthorized_origin`, `unsupported_frame_type`,
`unexpected_additional_frame`, `protocol_error: malformed_frame_json: ...`
(returned when stdin contains a frame whose body is not valid JSON), and
any error string surfaced by the underlying `fetch` to the assistant
(`failed to reach assistant at ...`, `assistant pair request failed with
HTTP 503`, etc.). Per the project-wide terminology rule in `AGENTS.md`,
all user-visible strings refer to the local process as the "assistant".

## Origin allowlist

Chrome appends the calling extension's origin (e.g.
`chrome-extension://<extension-id>/`) as the first
positional argument when launching the host. The helper parses this,
extracts the bare extension ID, and rejects anything not in
`ALLOWED_EXTENSION_IDS` in `src/index.ts` before reading any stdin
bytes.

Today the allowlist contains a single dev placeholder ID. The production
ID will be added before release -- see the `// TODO: production id before
release` comment in `src/index.ts`.

## Assistant port resolution

The helper looks up the assistant's HTTP port using the following
precedence (highest first):

1. **`--assistant-port <port>`** CLI flag -- accepts either
   `--assistant-port 7822` or `--assistant-port=7822`. This exists so a
   wrapper script registered in Chrome's `NativeMessagingHosts` manifest
   can pin the helper to a known port for non-default installs (e.g.
   named local instances spawned by `cli/src/lib/local.ts` which set
   `RUNTIME_HTTP_PORT` from `resources.daemonPort`).
2. **`~/.vellum/runtime-port`** lockfile -- a single integer written by
   the assistant on startup via
   `RuntimeHttpServer.writeRuntimePortFile()`. Default installs (and any
   setup with a single running assistant) resolve their port through
   this file without any manifest-side configuration.
3. **`7821`** -- the well-known default port.

If a step fails (file missing, parse error, etc.), resolution falls
through to the next step. The subsequent HTTP request will surface a
clear connection error if the assistant isn't actually listening on the
resolved port.

## Building

```bash
cd clients/chrome-extension/native-host
bun install
bun run build       # produces dist/index.js
```

`bun run build` is a thin wrapper around `tsc -p tsconfig.json`. The
output is a single ES module file under `dist/` that can be invoked
directly with `node dist/index.js`. This form is used by the integration
tests in `src/__tests__/` and by the manual smoke-test snippets below.

The dev Chrome wrapper documented in
`clients/chrome-extension/README.md` does **not** rely on `dist/` — it
points Bun at `src/index.ts` directly, so `src/` edits take effect
immediately without a rebuild.

## Bundling into the macOS app

The production macOS `.app` does **not** ship the `dist/index.js` form
-- Chrome's native messaging `path` field must point at a runnable
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

1. Chrome's native messaging host `path` must be executable -- it does
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
`clients/chrome-extension/native-host/com.vellum.daemon.json.template`.
`NativeMessagingInstaller` rebuilds the same structure in-memory via
`JSONSerialization` and overwrites the on-disk file on every launch
(idempotent) so that upgrading the app bundle automatically updates the
`path` and `allowed_origins` entries. The `__HELPER_BINARY_PATH__` and
`__VELLUM_EXTENSION_ID__` placeholders in the template are for
humans reading the checked-in file -- the actual install never
performs template substitution.

### Allowlist resolution in compiled builds

The helper enforces its own extension-ID allowlist before it calls the
assistant pair endpoint. The effective allowlist is the **union** of three
sources; all sources are consulted, and any one of them is sufficient to
admit an ID:

1. Canonical repo config at
   `meta/browser-extension/chrome-extension-allowlist.json` (repo checkout paths).
2. Local override at `~/.vellum/chrome-extension-allowlist.local.json`
   (optional — silently ignored if absent). Developers use this to allowlist
   an unpacked dev-build ID without committing it to the repo.
3. `VELLUM_CHROME_EXTENSION_IDS` (comma/space-separated) or
   `VELLUM_CHROME_EXTENSION_ID` (single ID).

`clients/macos/build.sh` injects `VELLUM_CHROME_EXTENSION_IDS` at compile
time from the canonical JSON allowlist so packaged binaries continue to work
even when repo-relative paths are unavailable.

The helper re-reads all sources on every `connectNative()` spawn, so
edits to the local override file take effect the next time Chrome launches
the helper — no Chrome restart needed. The assistant caches the
merged allowlist at startup; restart the assistant after editing the local
override.

## Testing

```bash
cd clients/chrome-extension/native-host
bun test src/__tests__/protocol.test.ts
```

The current test suite covers the framing protocol (round-trips,
multi-frame buffers, partial frames, empty buffers).

## Local manual smoke test

Once the assistant is running and exposing `/v1/browser-extension-pair`,
you can exercise the helper end-to-end without Chrome by piping
a framed request to it on stdin. If you need to allowlist an extra
extension ID, add it to `~/.vellum/chrome-extension-allowlist.local.json`
(see "Allowlist resolution in compiled builds" above).
Then run:

```bash
node --input-type=module -e "
  import { encodeFrame } from './dist/protocol.js';
  process.stdout.write(encodeFrame({ type: 'request_token' }));
" | node dist/index.js "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"
```

(The package is ESM -- `"type": "module"` in `package.json` -- so the
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

To list assistants from the lockfile:

```bash
node --input-type=module -e "
  import { encodeFrame } from './dist/protocol.js';
  process.stdout.write(encodeFrame({ type: 'list_assistants' }));
" | node dist/index.js "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"
```

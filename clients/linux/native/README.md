# Linux native helper

`linux-helper/` is a Rust crate producing `vellum-linux-helper`, one static
binary per architecture. It is the Linux counterpart to
`clients/macos/native/mac-helper` and
`clients/windows/native/Vellum.WindowsHelper`.

## Protocol

The Electron main process supervises the helper through
`@vellumai/native-sidecar` and exchanges newline-delimited JSON-RPC 2.0 frames
over stdin and stdout, using the error codes the supervisor understands
(`-32700`, `-32600`, `-32601`, `-32602`, `-32603`). Frames over 1 MiB are
dropped with a parse error rather than buffered, and the helper exits cleanly
when stdin reaches EOF.

Methods today: `ping` (replies `"pong"`, matching macOS) and
`capabilities.state` (session type, portal interface versions, accessibility
bus reachability, notification service presence, `/dev/input` readability).

## Adding a module

Add a file under `src/modules/`, implement `RpcModule`, call
`register_module!(YourModule)`, and add its `mod` line to `src/modules/mod.rs`.
Registration goes through `inventory`, so neither `main.rs` nor the dispatcher
changes; a duplicate method name fails startup. Modules report unavailable with
a reason instead of faking success on a session that cannot support them.

## Security model

- Same user, same session as the app. It never elevates or prompts for
  elevation; an unreachable target is reported unavailable.
- No network access: the local session bus, display server, and kernel input
  devices only.
- stdout is reserved for JSON-RPC frames. Logs go to stderr, filtered by
  `VELLUM_HELPER_LOG` (default `info`).
- Wayland privileged access goes through `xdg-desktop-portal`, so the user's
  own portal dialogs stay the consent boundary.

## Building

```bash
cd clients/linux
bun run test:native-helper   # cargo fmt --check, clippy -D warnings, test
bun run build:native-helper  # into resources/native-helper/<arch>/
```

Builds are native per architecture (`x86_64-unknown-linux-gnu` on an x64
runner, `aarch64-unknown-linux-gnu` on an arm64 runner); we do not
cross-compile. `scripts/pack.sh` builds the helper before electron-builder
picks it up through `extraResources`. Development and CI artifacts are
unsigned; release signing is owned by the release workflow.

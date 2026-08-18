# Vellum Assistant - Windows (Electron)

Bootstrap skeleton for the Windows desktop client. Like `clients/macos`, this is
an Electron shell around the `clients/web` renderer: in dev it loads the Vite dev
server (or vel's edge proxy when `vel up` is running), and in packaged builds
it serves a bundled `resources/web-dist` over a privileged `app://` protocol.

## What works today

- Hardened main window (context isolation, sandbox, shared creation seam in
  `packages/electron-desktop/src/windows.ts`) loading the assistant web UI.
  `src/main/windows.client.ts` is the Windows adapter.
- Same-origin navigation guard; external links open in the default browser;
  OAuth-style `window.open` popups allowed with the hardened baseline.
- Sender-validated IPC seam (`packages/electron-desktop/src/ipc.ts`) with a
  Windows adapter in `src/main/ipc.client.ts` and a minimal bridge:
  `window.vellum.app` (version info, open website), `window.vellum.commands`,
  functional main-window controls, presence, connectivity, identity, avatar,
  unread badge, and power-event capabilities, plus the `__VELLUM_CONFIG__` /
  `__VELLUM_FLAG_OVERRIDES__` globals. Unavailable required capabilities ship
  as documented no-op stubs; optional capabilities degrade to web behavior.
- Notification-area tray with live assistant status, window recovery,
  assistant and conversation actions, restart, and explicit quit. Unread and
  attention state appear on the Windows taskbar.
- Persisted main-window geometry and maximized state, load/show readiness,
  dynamic assistant titles, and frameless title-bar overlay controls.
- Static serving of the renderer from `src/main/index.ts`, with
  path-traversal protection from `@vellumai/electron-utils/app-protocol`,
  platform API forwarding, single-instance lock, per-environment `userData`
  separation, and `electron-log` file logging.
- `electron-builder` NSIS installer target (`bun run pack`).

## Packaged CLI provisioning

Packaged Windows startup installs the bundled CLI runtime for the current user:

- The immutable payload is read from `resources/cli-runtime` and copied to
  `<Electron userData>/cli/<version>`.
- `<Electron userData>/cli/install-state.json` records the current runtime and
  one valid fallback. Reusing an older installed version preserves the prior
  current version as the fallback.
- A small owned launcher is installed under `%LOCALAPPDATA%\Vellum\bin` and
  delegates to the selected versioned runtime. Non-production channels use
  separate launcher directories. A launcher without the Vellum ownership
  marker is left untouched.
- Long-lived assistant, gateway, and worker executables remain in the
  versioned runtime. Provisioning and uninstall never replace or remove those
  executables while they may be running.
- The versioned runtime includes the web SPA used by the web client and remote
  web ingress.
- The launcher directory is added to `HKCU\Environment\Path`. The app broadcasts
  the environment change to the Windows shell after a successful write.
- Machine PATH entries are evaluated before user entries. If another
  `vellum.exe` wins resolution, startup records the launcher as shadowed.

`vellum retire` stages assistant data before archiving it. On Windows the
background archive uses PowerShell and the built-in `tar.exe`; other platforms
use the existing POSIX archive process.

## Not ported yet (see `clients/macos/src/main/` for reference implementations)

- Gateway (`/assistant/__gateway/{port}/*`) request forwarding. Packaged
  builds cannot reach local gateways until this lands.
- Native auth / OAuth sign-in chain, notifications, auto-update, CSP, hotkeys,
  local-mode IPC (hatch/wake/retire), and device id.

## Development

```bash
bun run dev
```

Probes for `vel up` at `localhost:3000` and attaches to it, or falls back to
standalone mode (spawns `clients/web`'s Vite on :5173, shell only, no
backends). Scripts assume a POSIX shell; on Windows use Git Bash (or WSL).

To test local web changes against the deployed dev platform without starting
Vite or opening a local development port, run this from PowerShell:

```powershell
$env:VELLUM_ENVIRONMENT="dev"
$env:VELLUM_DEV_URL="https://dev-assistant.vellum.ai/assistant"
bun run dev:electron-local-web
```

This builds the local `clients/web` source, serves it from Electron's
`app://` origin, and forwards platform API requests to `dev-assistant`.

## Packaging

```bash
bun run build:web   # builds clients/web into resources/web-dist
bun run pack        # electron-vite build + electron-builder --win (NSIS)
```

Unsigned; code signing and publishing are not wired up yet.

## Checks

```bash
bun run typecheck
bun run test:ci
```

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
  `window.vellum.identity.setName`, and functional `mainWindow.ensureVisible` /
  `mainWindow.setOnboarding`, plus the `__VELLUM_CONFIG__` /
  `__VELLUM_FLAG_OVERRIDES__` globals. Namespaces the renderer dereferences
  unguarded when `platform` is `"electron"` (`power`, `deepLinks`, `dock`,
  `menu`, `localMode`) ship as documented no-op stubs; the rest are
  feature-detected by the renderer's runtime wrappers and degrade to web
  behavior until ported.
- Persisted main-window geometry and maximized state, load/show readiness,
  dynamic assistant titles, and frameless title-bar overlay controls.
- Packaged static serving of the renderer from `src/main/index.ts`, with
  path-traversal protection from `@vellumai/electron-utils/app-protocol`,
  single-instance lock, per-environment `userData` separation, and
  `electron-log` file logging.
- `electron-builder` NSIS installer target (`bun run pack`).

## Packaged CLI provisioning

Packaged Windows startup installs the bundled CLI runtime for the current user:

- The immutable payload is read from `resources/cli-runtime` and copied to
  `<Electron userData>/cli/<version>`.
- `<Electron userData>/cli/install-state.json` records the current runtime and
  one valid fallback. Reusing an older installed version preserves the prior
  current version as the fallback.
- Owned launchers are installed under `%LOCALAPPDATA%\Vellum\bin`. A launcher
  without the Vellum ownership marker is left untouched.
- The launcher directory is added to `HKCU\Environment\Path`. The app broadcasts
  the environment change to the Windows shell after a successful write.
- Machine PATH entries are evaluated before user entries. If another
  `vellum.exe` wins resolution, startup records the launcher as shadowed.

`vellum retire` stages assistant data before archiving it. On Windows the
background archive uses PowerShell and the built-in `tar.exe`; other platforms
use the existing POSIX archive process.

## Not ported yet (see `clients/macos/src/main/` for reference implementations)

- Gateway (`/assistant/__gateway/{port}/*`) and platform (`/v1/*`,
  `/_allauth/*`, `/accounts/*`) request forwarding. Packaged builds can't
  reach local gateways or the cloud platform until this lands; dev runs are
  unaffected because the Vite dev server proxies both.
- Native auth / OAuth sign-in chain, deep links (`vellum://`), tray,
  notifications, auto-update, CSP, hotkeys, local-mode IPC (hatch/wake/
  retire), and device id.

## Development

```bash
bun run dev
```

Probes for `vel up` at `localhost:3000` and attaches to it, or falls back to
standalone mode (spawns `clients/web`'s Vite on :5173, shell only, no
backends). Scripts assume a POSIX shell; on Windows use Git Bash (or WSL).

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

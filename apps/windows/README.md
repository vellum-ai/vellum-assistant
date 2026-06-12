# Vellum Assistant — Windows (Electron)

Bootstrap skeleton for the Windows desktop client. Like `apps/macos`, this is
an Electron shell around the `apps/web` renderer: in dev it loads the Vite dev
server (or vel's edge proxy when `vel up` is running), and in packaged builds
it serves a bundled `resources/web-dist` over a privileged `app://` protocol.

## What works today

- Hardened main window (context isolation, sandbox, single creation seam in
  `src/main/windows.ts`) loading the assistant web UI.
- Same-origin navigation guard; external links open in the default browser;
  OAuth-style `window.open` popups allowed with the hardened baseline.
- Sender-validated IPC seam (`src/main/ipc.ts`) with a minimal bridge:
  `window.vellum.app` (version info, open website), `window.vellum.commands`,
  `mainWindow.ensureVisible`, plus the `__VELLUM_CONFIG__` /
  `__VELLUM_FLAG_OVERRIDES__` globals. Namespaces the renderer dereferences
  unguarded when `platform` is `"electron"` (`power`, `deepLinks`, `dock`,
  `menu`, `localMode`, `mainWindow.setOnboarding`) ship as documented no-op
  stubs; the rest are feature-detected by the renderer's runtime wrappers and
  degrade to web behavior until ported.
- Packaged static serving of the renderer with path-traversal protection
  (`src/main/app-protocol.ts`), single-instance lock, per-environment
  `userData` separation, `electron-log` file logging.
- `electron-builder` NSIS installer target (`bun run pack`).

## Not ported yet (see `apps/macos/src/main/` for reference implementations)

- Gateway (`/assistant/__gateway/{port}/*`) and platform (`/v1/*`,
  `/_allauth/*`, `/accounts/*`) request forwarding — packaged builds can't
  reach local gateways or the cloud platform until this lands; dev runs are
  unaffected because the Vite dev server proxies both.
- Native auth / OAuth sign-in chain, deep links (`vellum://`), tray,
  notifications, auto-update, CSP, hotkeys, local-mode IPC (hatch/wake/
  retire), window-state persistence, device id, frameless title bar.

## Development

```bash
bun run dev
```

Probes for `vel up` at `localhost:3000` and attaches to it, or falls back to
standalone mode (spawns `apps/web`'s Vite on :5173 — shell only, no
backends). Scripts assume a POSIX shell; on Windows use Git Bash (or WSL).

## Packaging

```bash
bun run build:web   # builds apps/web into resources/web-dist
bun run pack        # electron-vite build + electron-builder --win (NSIS)
```

Unsigned; code signing and publishing are not wired up yet.

## Checks

```bash
bun run typecheck
bun test
```

# Electron wrapper

Desktop shell for the Vellum Assistant macOS app. Wraps [`apps/web/`](../web/)
in an Electron `BrowserWindow` and supervises the bundled assistant binary
shipped under `Resources/`.

This package is the macOS distribution surface (outside the App Store).
Code signing, notarization, and auto-update wiring live in follow-up tickets.

> **Note on workflow filenames.** This directory is `apps/macos/` to match the
> platform-named convention used by `apps/ios/`, but the CI workflow files are
> still named `pr-electron.yaml` / `ci-main-electron.yaml` because
> `.github/workflows/ci-main-macos.yaml` is already taken by the legacy
> native Swift app at [`clients/macos/`](../../clients/macos/). The workflow
> filenames will be renamed to `-macos.yaml` once `clients/macos/` retires.

## Prerequisites

- Bun (see `.tool-versions` at the repo root)
- The web dev server must be running before `bun run dev` here:

  ```sh
  cd ../web && bun install && bun run dev
  ```

  That serves the renderer on `http://localhost:5173`, which Electron loads
  in development.

## How it runs

- **Dev** — Electron loads `http://localhost:5173` directly. Hot reload comes
  from Vite in `apps/web/`.
- **Prod** — A custom `app://vellum.ai/` protocol serves the static
  `apps/web/dist/` bundle. Same-origin policy treats `app://` as a secure
  standard scheme.
- **Assistant process** — The main process spawns the bundled assistant
  binary at `process.resourcesPath/bun` (invoked with the `daemon` subcommand
  the binary itself exposes). If it exits, it restarts with exponential
  backoff (1s → 2s → 4s, capped at 30s). The backoff resets to 1s after any
  run that stayed up for at least 60s, so a transient crash after a long
  stable run doesn't inherit the prior wait. Missing binary (ENOENT) is
  logged but does not retry — expected in local dev where the assistant
  isn't bundled yet.

## Scripts

```sh
bun install
bun run dev        # electron-vite dev — opens the BrowserWindow
bun run build      # electron-vite build — bundles main + preload to out/
bun run dist       # electron-builder — produces a DMG (signing/notarization TBD)
bun run typecheck  # tsc --noEmit
```

## Layout

```
apps/macos/
├── electron.vite.config.ts   # main + preload Vite entries (no renderer)
├── src/
│   ├── main/index.ts         # window creation, app://, assistant supervisor
│   └── preload/index.ts      # contextBridge: window.vellum.*
└── tsconfig.json
```

## Renderer bridge

The preload script exposes a typed `window.vellum` API to the renderer. Today
it only reports `platform: "electron"`; auth, settings, and helper methods
are typed stubs to be wired up in follow-up tickets.

Verify the bridge from the renderer:

```js
console.log(window.vellum.platform); // "electron"
```

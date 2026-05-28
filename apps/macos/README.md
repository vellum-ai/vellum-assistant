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

## Native macOS integration

- **Application menu** (`src/main/menu.ts`). Installs a standard macOS menu
  bar with `Vellum`, `Edit`, `View`, `Window`, and `Help` submenus, all
  role-based so they work without renderer IPC. `View > Toggle Developer
  Tools` is gated to dev builds only so the packaged DMG doesn't expose
  devtools to end users.

  A `File` menu with `New Conversation` / `Current Conversation` /
  `Mark Unread` is intentionally absent. Those items need a typed
  command/hotkey system (main-process command bus → typed preload
  subscription → renderer dispatcher) and the renderer-side handlers in
  `apps/web` so they actually do work when clicked. That system lands as
  one cohesive PR that wires main + preload + renderer together. Shipping
  menu items that no-op on click would be the kind of dormant surface
  this codebase has been backing out of.

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
│   ├── main/settings.ts      # electron-store schema + IPC-backed accessors
│   ├── main/menu.ts          # macOS application menu
│   └── preload/index.ts      # contextBridge: window.vellum.*
└── tsconfig.json
```

## Renderer bridge

The preload script exposes a typed `window.vellum` API to the renderer:

- `platform: "electron"` — host discriminator.
- `settings.get<T>(key)` / `settings.set<T>(key, value)` — persisted preferences,
  backed by `electron-store` in the main process. Writes are validated against
  a JSON schema (`hotkeys`, `theme`, `featureFlags`); a schema violation
  surfaces as a rejected `Promise`.
- `commands.on(callback)` — subscribe to main-process commands dispatched
  by the application menu (and, eventually, global hotkeys). Returns an
  unsubscribe function. The renderer-side wrapper is
  [`apps/web/src/runtime/vellum-commands.ts`](../web/src/runtime/vellum-commands.ts);
  feature code mounts the `useVellumCommands` hook with a partial handler
  map at whichever component owns the relevant state.
- `auth.*` and `helper.*` — typed stubs that reject with "not implemented yet"
  until the corresponding feature tickets land.

Verify the bridge from the renderer:

```js
console.log(window.vellum.platform); // "electron"
await window.vellum.settings.set("theme", "dark");
console.log(await window.vellum.settings.get("theme")); // "dark"
```

### When to extend the bridge with new methods

The generic `settings.{get,set}` surface is appropriate for user preferences
where the renderer is the source of truth and the value is non-sensitive
(theme, layout, feature-flag overrides, etc.). For higher-sensitivity
capabilities — auth tokens, biometric keys, file paths, anything where the
renderer should not be free to read or write arbitrary keys — add a
dedicated bridge method (`window.vellum.<capability>.<verb>()`) with its
own IPC channel. This follows Electron's "one method per IPC message"
guidance from the [security tutorial](https://www.electronjs.org/docs/latest/tutorial/security#17-validate-the-sender-of-all-ipc-messages),
which keeps the renderer-exposed surface narrow and auditable.

Renderer-side consumers in `apps/web/` should wrap bridge access in a
per-capability module (see `apps/web/src/runtime/native-biometric.ts` for
the established shape) rather than reaching into `window.vellum.*`
directly from feature code. That keeps the platform-branching logic in
one place and makes the cross-platform contract (web / iOS / Electron)
live in TypeScript types.

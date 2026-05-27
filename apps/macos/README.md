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
  devtools to end users. A `File` menu with `New Conversation` / `Mark
  Unread` etc. lands in a follow-up ticket alongside the renderer-side
  handlers — shipping menu items that no-op when clicked is worse than
  omitting them.
- **Sleep / wake** (`src/main/power.ts`). The main process logs
  `powerMonitor` `suspend` and `resume` events for diagnostic visibility.
  No IPC bridge to the renderer yet: Chromium's `visibilitychange` already
  fires when the screen sleeps, and the renderer's existing event-bus
  listener (`apps/web/src/hooks/use-event-bus-init.ts`) catches it. A
  bridge can be added when a feature needs an earlier signal than
  `visibilitychange` carries.
- **Launch at login** (`src/main/login-item.ts`). On startup the main
  process reads `featureFlags.loginAtStartup` from the settings store and
  calls `app.setLoginItemSettings` to match. It also subscribes to the
  setting via `electron-store`'s `onDidChange` so a future renderer-side
  toggle takes effect immediately without an app restart. Default is off;
  until a settings UI lands, the manual escape hatch is to set
  `featureFlags.loginAtStartup = true` in
  `~/Library/Application Support/Vellum Dev/config.json`.

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
│   ├── main/power.ts         # powerMonitor suspend / resume listeners
│   ├── main/login-item.ts    # launch-at-login wiring driven by settings
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

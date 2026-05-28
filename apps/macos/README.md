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

That's it — `bun run dev` and `bun run dev:electron-only` both run
`bun install` for you on first launch (and verify on subsequent runs,
which is a fast no-op when the lockfile already matches).

## How it runs

`bun run dev` is the one command. On launch it probes
`http://localhost:3000` (the URL Swift Vellum hits — `vel up`'s edge
proxy) with a 1.5s timeout and picks one of two paths:

1. **vel up is running** → dispatches to `dev:electron-only` with
   `VELLUM_DEV_URL=http://localhost:3000`. No Vite is spawned here; the
   Electron BrowserWindow loads the edge proxy URL and reuses vel's
   backends (Django, gateway, daemon) the same way Swift Vellum does
   today. This is the common case once you have `vel up` going.

2. **No vel up** → dispatches to `dev:standalone`, which uses
   [`concurrently`](https://github.com/open-cli-tools/concurrently) to
   run two children in parallel:
   - `dev:web` → `cd ../web && bun run dev -- --port 5173 --strictPort`.
     Going through `apps/web`'s own `dev` script means we use *its*
     local Vite (8.x) and plugin tree, not whatever older Vite happens
     to live in `apps/macos/node_modules`. Pinning the port via the
     Vite CLI overrides `apps/web/.env` if `PORT` is set there.
   - `dev:electron` → [`wait-on`](https://github.com/jeffbski/wait-on)
     polls `:5173` (30s timeout), then runs `electron-vite dev` against
     it. The wait avoids Electron racing the renderer.

   `concurrently --kill-others` tears both down on Ctrl+C or on either
   child exiting. Logs are prefixed and color-coded (`[web]` blue,
   `[electron]` green). Standalone mode has no backends, so renderer
   API calls will fail — useful for shell-only work (menus, IPC, window
   chrome), not for feature development against the real stack.

The main-process URL choice lives in `src/main/index.ts`:
`process.env.VELLUM_DEV_URL ?? "http://localhost:5173"`. Override the
env var yourself (e.g., `VELLUM_DEV_URL=http://localhost:3002 bun run
dev:electron-only`) if you need to point at a non-default service.

The app shows up as **Vellum Electron** in the menu bar and Dock
(via `app.setName`, gated to `!app.isPackaged` in `src/main/index.ts`),
and writes preferences / electron-store data under
`~/Library/Application Support/Vellum Electron/`. That keeps it cleanly
separate from the Swift `Vellum.app`, `Vellum Local.app`, and
`Vellum Dev.app` installs — running this locally won't clobber
whichever Swift channel you have around.

You don't have to ship a DMG to try it. Packaging (DMG, signing,
notarization, auto-update) lands in follow-up tickets once we actually
need a distributable artifact.

- **Dev (vel up)** — Electron loads `http://localhost:3000` (edge proxy).
- **Dev (standalone)** — Electron loads `http://localhost:5173` (our Vite).
- **Prod (future)** — A custom `app://vellum.ai/` protocol serves the
  static `apps/web/dist/` bundle. Same-origin policy treats `app://` as
  a secure standard scheme.
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
  bar with `Vellum`, `File`, `Edit`, `View`, `Window`, and `Help` submenus.
  Most items are role-based so they work without renderer IPC; the `File`
  items dispatch through the typed command bus in `src/main/commands.ts`,
  which broadcasts to the focused window's renderer via a single
  `vellum:command` IPC channel (subscribed to by `useVellumCommands` in
  `apps/web/src/runtime/vellum-commands.ts`). Accelerators are read from
  `settings.hotkeys.<kind>` with defaults from `DEFAULT_ACCELERATORS`.
  `View > Toggle Developer Tools` is gated to dev builds only so the
  packaged build doesn't expose devtools to end users.

## Scripts

```sh
bun run dev                # probe vel-up at :3000, dispatch to dev:electron-only or dev:standalone
bun run dev:standalone     # explicit: spawn our Vite (:5173) + electron-vite dev (no backends)
bun run dev:electron-only  # explicit: electron-vite dev only, honors $VELLUM_DEV_URL (default :5173)
bun run install:all        # bun install in apps/macos and apps/web (called automatically by dev)
bun run dev:web            # apps/web Vite (port 5173, strict) — invoked by dev:standalone
bun run dev:electron       # wait-on :5173 then electron-vite dev — invoked by dev:standalone
bun run build              # electron-vite build — bundles main + preload to out/
bun run typecheck          # tsc --noEmit
```

## Layout

```
apps/macos/
├── electron.vite.config.ts   # main + preload Vite entries (no renderer)
├── scripts/
│   └── dev.ts                # probes vel-up at :3000, dispatches to standalone or electron-only
├── src/
│   ├── main/index.ts         # window creation, app://, assistant supervisor
│   ├── main/commands.ts      # typed command bus + accelerator resolver
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

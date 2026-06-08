# Electron wrapper

Desktop shell for the Vellum Assistant macOS app. Wraps [`apps/web/`](../web/)
in an Electron `BrowserWindow`. Each assistant's background processes are owned
entirely by the `vellum` CLI, which the app invokes as a subprocess — the
Electron app is a GUI client, not a process manager.

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
   `VELLUM_DEV_URL=http://localhost:3000/assistant`. No Vite is spawned
   here; the Electron BrowserWindow loads the edge proxy at the
   `/assistant` path (the bare root is the marketing site) and reuses
   vel's backends (Django, gateway, daemon) the same way Swift Vellum
   does today. This is the common case once you have `vel up` going.

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
`process.env.VELLUM_DEV_URL ?? "http://localhost:5173/assistant"`.
`VELLUM_DEV_URL` is treated as the full URL — callers must include the
`/assistant` path themselves because `apps/web/vite.config.ts` sets
`base: "/assistant/"` (so the bare origin lands the BrowserWindow on
the marketing page in vel-up mode, or on a Vite 404 in standalone).
Override the env var yourself (e.g.,
`VELLUM_DEV_URL=http://localhost:3002/assistant bun run dev:electron-only`)
if you need to point at a non-default service.

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

- **Dev (vel up)** — Electron loads `http://localhost:3000/assistant` (edge proxy + the path apps/web's Vite is configured for).
- **Dev (standalone)** — Electron loads `http://localhost:5173/assistant` (our Vite, same path).
- **Prod (future)** — A custom `app://vellum.ai/` protocol serves the
  static `apps/web/dist/` bundle. Same-origin policy treats `app://` as
  a secure standard scheme.
- **Assistant process** — The app does not run or supervise any background
  process of its own. Each local assistant runs its own processes, spawned and
  managed by the `vellum` CLI; the main process only invokes the CLI as a
  subprocess for lifecycle ops (hatch, retire, token). Packaging the CLI
  runtime so this works in distributed builds is tracked in LUM-2085.

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
bun run test               # bun test — single Bun process (fastest for local iteration)
bun run test:ci            # bun scripts/run-tests.ts — each file in its own subprocess (mock-safe; what CI runs)
```

## Testing

Pure functions under `src/main/` and `src/preload/` are unit-tested with
[Bun's built-in test runner](https://bun.sh/docs/test/writing). Tests
colocate next to source files (`commands.ts` → `commands.test.ts`).

The real `electron` module isn't loadable off-Electron, so
[`test-setup.ts`](./test-setup.ts) is preloaded by
[`bunfig.toml`](./bunfig.toml) and mocks the surface every `src/main/`
file imports at the top level. Tests that exercise a specific Electron
API (e.g. `screen.getDisplayMatching`) re-mock it locally via
`mock.module("electron", …)` inside the test file.

`scripts/run-tests.ts` runs each test file in its own Bun subprocess —
[`mock.module()` mutates a process-global registry](https://bun.sh/docs/test/mocking#mock-module),
so mocks set in one file would leak into the next. Use `bun run test`
for fast local iteration on a single file and `bun run test:ci` (or a
single targeted file: `bun scripts/run-tests.ts src/main/foo.test.ts`)
when running the full suite.

## Layout

```
apps/macos/
├── electron.vite.config.ts   # main + preload Vite entries (no renderer)
├── scripts/
│   └── dev.ts                # probes vel-up at :3000, dispatches to standalone or electron-only
├── src/
│   ├── main/index.ts         # app:// protocol, app lifecycle, popup hardening
│   ├── main/windows.ts       # hardened window-creation seam (webPreferences + nav policy)
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
- `dock.setBadge(count)` / `dock.setSignedIn(signedIn)` — publish the
  inputs that drive the Dock unread badge and visibility state machine
  in [`src/main/dock.ts`](src/main/dock.ts). Renderer wrapper at
  [`apps/web/src/runtime/dock.ts`](../web/src/runtime/dock.ts) (no-ops
  off Electron); feature code calls
  `useElectronDockSync(conversations)` from `ChatLayout` to keep them in
  sync. The accessory-mode (Dock-hidden) transition is gated on
  `ALLOW_ACCESSORY_MODE` until a menu-bar (tray) entry point exists;
  until then the icon stays in the Dock so the user always has a way
  back to the window.
- `localMode.*` — provisions and retires local assistants and reads/writes
  the lockfile that records them. `hatch(species)` and `retire(assistantId)`
  drive the Vellum CLI as a subprocess; `readLockfile()`,
  `saveLockfileAssistant(assistant, activeAssistant?)`, and
  `replacePlatformAssistants(platformAssistants)` read and write the lockfile
  on disk. Every method is a thin wrapper over [`@vellumai/local-mode`](../../packages/local-mode/),
  the shared host library that also backs the web app's dev-server middleware,
  so the spawn/parse and lockfile logic lives in one place. The renderer-side
  transport seam is [`apps/web/src/runtime/local-mode-host.ts`](../web/src/runtime/local-mode-host.ts),
  which selects this bridge on Electron and the dev-server `/assistant/__local/*`
  middleware on web/dev so both hosts honor the same contract.
- `helper.hotkey.fnPushToTalk(enable)` — starts or stops the native helper
  that captures the Fn key globally for Push to Talk, with
  `helper.hotkey.onEvent(callback)` streaming `down` / `up` notifications.
- `helper.ping()` — health-checks the native helper over JSON-RPC stdio.
- `auth.*` — typed stubs that reject with "not implemented yet" until the
  corresponding feature tickets land.

The native helper lives in `native/mac-helper/` as a small Swift package.
`MacHelperCore` owns JSON-RPC 2.0 NDJSON framing, standard error codes, and
method routing so protocol behavior is unit-testable without spawning a
process. The `vellum-mac-helper` executable is the thin AppKit/Carbon entrypoint;
it logs to stderr and keeps stdout reserved for RPC frames and notifications.

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

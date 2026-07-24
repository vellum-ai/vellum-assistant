# Desktop Shell — Agent Instructions

Applies to all code under `packages/desktop-shell/`. Subordinate to root [`AGENTS.md`](../../AGENTS.md).

## What this package is

The cross-platform Electron **main process** (`src/main/`) and **preload
bridge** (`src/preload/`) shared by every desktop client. `clients/macos` and
`clients/linux` are thin build-config wrappers: their `electron.vite.config.ts`
points `main`/`preload` at this package's source, so both desktop apps run the
**same** runtime code. This is the single source of truth — desktop behavior
lives here, not duplicated per client.

## Rules

1. **No client-specific logic.** Anything a client needs at runtime belongs
   here; a client directory holds only its build config, packaging scripts, and
   native helpers. Never re-add copies of these modules under `clients/*/src/`.

2. **Gate OS-specific behavior on the platform.** macOS-only APIs (dock, tray,
   traffic-light `setWindowButtonPosition`, AppleScript, the `vellum-mac-helper`
   sidecar, app relocation) must be guarded — `process.platform === "darwin"`,
   the module's `isMac` constant, or the sidecar's `this.platform` seam — so the
   Linux (and any future Windows) build compiles and runs unaffected. OS-only
   code may still live here as long as it is gated; it does not move back into a
   client.

3. **Bundler module resolution — no `.js` extensions.** `tsconfig` uses
   `moduleResolution: "Bundler"` with `module: "ESNext"` (electron-vite bundles
   this source). Relative imports are extensionless (`./about`, not
   `./about.js`), matching `clients/`. Do **not** switch to NodeNext.

4. **Tests run through the isolated runner.** The `electron` module is a native
   binary that can't load off-Electron, so `test-setup.ts` (preloaded via
   `bunfig.toml`) shims it. Bun's `mock.module()` mutates a process-global
   registry that leaks between files, so run the suite with
   `bun run test:ci` (`scripts/run-tests.ts`, one process per file) — **never**
   a bare `bun test` across the whole package. A test that asserts macOS-only
   behavior must pin `process.platform` to `"darwin"` (restore it in
   `afterEach`), since CI runs on Linux.

## Review checklist

- [ ] No relative imports back into a client (`clients/*`), and no client
      re-implementing a module that lives here
- [ ] macOS-only API calls are platform-gated
- [ ] Relative imports have no `.js` extension (Bundler resolution)
- [ ] New/changed behavior has a test; macOS-specific assertions pin the platform
- [ ] Full suite verified with `bun run test:ci`, not bare `bun test`

## Commands

```bash
cd packages/desktop-shell
bun run typecheck   # bunx tsc --noEmit
bun run test:ci     # isolated per-file test runner
```

## Dependencies

- Use `bun add --exact` for all dependencies (enforced by root `bunfig.toml`).
- `electron` is a **peer dependency** (`>=` range) — the client supplies the
  pinned version it packages against.
- All deps must have MIT-compatible licenses.

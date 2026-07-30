# clients/

Home for end-user client surfaces of the Vellum assistant — browser, mobile,
and desktop wrappers that users interact with directly.

## Structure

```
clients/
├── web/               # Web app (Vite)
├── ios/               # iOS Capacitor shell
├── macos/             # macOS desktop wrapper (Electron / electron-vite)
├── linux/             # Linux desktop wrapper (Electron / electron-vite, AppImage)
└── chrome-extension/  # MV3 Chrome browser extension
```

The iOS app is a Capacitor shell that lives in [`ios/`](./ios/); it loads the
web app over HTTPS and does not consume any code from the other client
surfaces.

The macOS and Linux apps are Electron wrappers around the web app. They share a
single main-process + preload runtime in
[`packages/desktop-shell`](../packages/desktop-shell/); each client directory
carries only its build config, packaging scripts, and native helpers.
Platform-specific behavior is gated inside `desktop-shell`, so the two shells
run identical code apart from their build/packaging commands.

## What belongs here

- End-user client surfaces (web app, iOS Capacitor wrapper, macOS/Electron
  wrapper, Chrome extension).

## What does not belong here

- Shared libraries — these live in `packages/`.
- Backend services — `assistant/`, `gateway/`, `credential-executor/`, `cli/`
  stay at the repo root.

## Conventions

- Each client subdirectory is its own self-contained Bun package with its own
  `bun.lock`, `package.json`, `tsconfig.json`, and lint config — matching the
  existing pattern used by other TypeScript packages in this repo.
- No workspaces, no Turborepo. Per-package dependency installs with
  `bun install`. Exact version pinning (see root [`AGENTS.md`](../AGENTS.md)).
- When a new client is added under `clients/`, add corresponding `paths:` globs
  to any relevant PR/CI workflows in `.github/workflows/`.

## Notes

- **Desktop workflow filenames** — each Electron client is a canonical
  platform-named directory with matching CI workflow files: `pr-macos.yaml` /
  `ci-main-macos.yaml` for `clients/macos/`, and `pr-linux.yaml` /
  `ci-main-linux.yaml` for `clients/linux/`. Their shared runtime has
  `pr-desktop-shell.yaml` / `ci-main-desktop-shell.yaml`.

## Chrome Extension

See [`chrome-extension/README.md`](chrome-extension/README.md) for build, load,
environment, and publishing instructions.

# clients/

Home for end-user client surfaces of the Vellum assistant — browser, mobile,
and desktop wrappers that users interact with directly.

## Structure

```
clients/
├── web/               # Web app (Vite)
├── docs/              # Public docs site: SSR Next.js app serving www.vellum.ai/docs
├── ios/               # iOS Capacitor shell
├── android/           # Android Capacitor shell
├── macos/             # macOS desktop wrapper (Electron / electron-vite)
└── chrome-extension/  # MV3 Chrome browser extension
```

The iOS app is a Capacitor shell that lives in [`ios/`](./ios/); it loads the
web app over HTTPS and does not consume any code from the other client
surfaces.

The Android app is a Capacitor shell that lives in [`android/`](./android/);
it follows the same remote web app loading model as iOS.

## What belongs here

- End-user client surfaces (web app, iOS Capacitor wrapper, macOS/Electron
  wrapper, Chrome extension).

## What does not belong here

- Shared libraries — these live in `packages/`.
- Backend services — `assistant/`, `gateway/`, `credential-executor/`, `cli/`
  stay at the repo root.

## Conventions

- `web/`, `macos/`, and `docs/` are members of the root bun workspace: the
  single root `bun.lock` covers them, and `bun install` anywhere in the tree
  resolves to the workspace root. Each keeps its own `package.json`,
  `tsconfig.json`, and lint config.
- `chrome-extension/` is the one standalone package, with its own `bun.lock`
  and per-package `bun install`. Native shells (`ios/`, `android/`) are
  Capacitor shells built from `web/` and have no package manifests of their
  own.
- Exact version pinning applies repo-wide (see root [`AGENTS.md`](../AGENTS.md)).
- When a new client is added under `clients/`, add corresponding `paths:` globs
  to any relevant PR/CI workflows in `.github/workflows/`.

## Notes

- **macOS workflow filenames** — `clients/macos/` is the canonical
  platform-named directory, and its CI workflow files are `pr-macos.yaml` /
  `ci-main-macos.yaml`.

## Chrome Extension

See [`chrome-extension/README.md`](chrome-extension/README.md) for build, load,
environment, and publishing instructions.

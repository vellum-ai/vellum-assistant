# clients/

Home for end-user client surfaces of the Vellum assistant — browser, mobile,
and desktop wrappers that users interact with directly.

## Structure

```
clients/
├── web/               # Web app (Vite)
├── ios/               # iOS Capacitor shell
├── android/           # Android Capacitor shell
├── macos/             # macOS desktop wrapper (Electron / electron-vite)
└── chrome-extension/  # MV3 Chrome browser extension
```

The iOS app is a Capacitor shell that lives in [`ios/`](./ios/); it loads the
web app over HTTPS and does not consume any code from the other client
surfaces.

The Android app is a Capacitor shell that lives in [`android/`](./android/);
it follows the same remote web app loading model as iOS. Its README documents
local variants, signed AAB builds, and Play internal-track prerequisites.

## What belongs here

- End-user client surfaces (web app, iOS Capacitor wrapper, macOS/Electron
  wrapper, Chrome extension).

## What does not belong here

- Shared libraries — these live in `packages/`.
- Backend services — `assistant/`, `gateway/`, `credential-executor/`, `cli/`
  stay at the repo root.

## Conventions

- JavaScript client packages use the root Bun workspace and root `bun.lock`.
  Native shells such as `ios/` and `android/` consume Capacitor dependencies
  from `web/` and do not have separate package manifests.
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

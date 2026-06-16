# apps/

Home for end-user app surfaces of the Vellum assistant — browser, mobile, and
desktop wrappers that users interact with directly.

## What belongs here

- End-user app surfaces (web app, iOS Capacitor wrapper, macOS/Electron wrapper,
  Chrome extension).

## What does not belong here

- Shared libraries — these live in `packages/` or `clients/shared/`.
- Native Swift macOS client — `clients/macos/` (legacy; being replaced by
  `apps/macos/` Electron).
- Backend services — `assistant/`, `gateway/`, `credential-executor/`, `cli/`
  stay at the repo root.

## Conventions

- Each app subdirectory is its own self-contained Bun package with its own
  `bun.lock`, `package.json`, `tsconfig.json`, and lint config — matching the
  existing pattern used by other TypeScript packages in this repo.
- No workspaces, no Turborepo. Per-package dependency installs with
  `bun install`. Exact version pinning (see root [`AGENTS.md`](../AGENTS.md)).
- When a new app is added under `apps/`, add corresponding `paths:` globs to
  any relevant PR/CI workflows in `.github/workflows/`.

## Notes

- **macOS workflow filenames** — `apps/macos/` is the canonical platform-named
  directory, and its CI workflow files are `pr-macos.yaml` /
  `ci-main-macos.yaml`.
- **Chrome extension** — currently at `clients/chrome-extension/`; planned to
  move to `apps/chrome-extension/`.

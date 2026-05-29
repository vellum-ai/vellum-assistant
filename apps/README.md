# apps/

Home for end-user app surfaces of the Vellum assistant — browser, mobile, and
desktop wrappers that users interact with directly. This directory is part of
the ongoing Web App Repo Move; surfaces will be migrated here incrementally in
follow-up PRs.

## What belongs here

- End-user app surfaces (e.g. the Chrome extension, future web app, iOS
  Capacitor wrapper, macOS/Electron wrapper).

## What does not belong here

- Shared libraries — these live in `packages/` or `clients/shared/`.
- Native Swift clients — `clients/macos/` remains the source of truth for the
  macOS app.
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

## Planned moves

- **Chrome extension** — `clients/chrome-extension/` will move to
  `apps/chrome-extension/` (preserving its name) in a follow-up PR. Scoped
  separately so its impact on Chrome Web Store release workflows can be
  reviewed in isolation.
- **macOS workflow filenames** — `apps/macos/` is the canonical platform-named
  directory, but its CI workflow files are still named
  `pr-electron.yaml` / `ci-main-electron.yaml` because
  `.github/workflows/ci-main-macos.yaml` is taken by the legacy native Swift
  app at `clients/macos/`. The workflow filenames will be renamed to
  `-macos.yaml` once `clients/macos/` retires.

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
- The local-daemon web interface — `clients/web/` is an internal control plane
  served by `vellum client --interface web`, not an end-user surface.
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

The current Chrome extension at `clients/chrome-extension/` is the first
candidate for relocation under this directory. That move is intentionally
scoped to a separate follow-up PR so its impact on Chrome Web Store release
workflows can be reviewed in isolation.

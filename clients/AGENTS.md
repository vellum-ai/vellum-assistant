# clients/ — Agent Guidance

Applies to all code under `clients/`. Subordinate to root [`AGENTS.md`](../AGENTS.md).

## Conventions

- Each subdirectory is its own self-contained Bun package with its own
  `bun.lock`, `package.json`, `tsconfig.json`, and lint config.
- No workspaces, no Turborepo. Per-package `bun install`. Exact version
  pinning is enforced repo-wide; see root `AGENTS.md` for the dependency,
  license, and tool-version rules.
- All current client apps use bundlers (`clients/web/` via Vite,
  `clients/macos/` via electron-vite) and therefore use
  `moduleResolution: "Bundler"` with `module: "ESNext"`. Bundler-mode apps
  omit `.js` extensions on imports. If a future client compiles without a
  bundler, use NodeNext with `.js` extensions (matching `assistant/`,
  `gateway/`, `cli/`).

## Adding a new client

When adding a new subdirectory under `clients/`, add a corresponding `paths:`
glob to relevant PR/CI workflows in `.github/workflows/`, and add an
appropriate ignore pattern to `.gitignore` if the client produces build
artifacts.

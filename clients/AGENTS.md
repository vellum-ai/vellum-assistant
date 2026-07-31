# clients/ — Agent Guidance

Applies to all code under `clients/`. Subordinate to root [`AGENTS.md`](../AGENTS.md).

## Conventions

- `clients/web/`, `clients/macos/`, and `clients/docs/` are members of the
  root bun workspace: the single root `bun.lock` covers them, and
  `bun install` anywhere in the tree resolves to the workspace root (scope
  with `--filter=@vellumai/<name>` when needed). Each keeps its own
  `package.json`, `tsconfig.json`, and lint config.
- `clients/chrome-extension/` is the one standalone package, with its own
  `bun.lock` and per-package `bun install`. Native shell directories
  (`clients/ios/`, `clients/android/`) are Capacitor shells built from
  `clients/web/` and have no package manifests of their own.
- Exact version pinning is enforced repo-wide; see root `AGENTS.md` for the
  dependency, license, and tool-version rules.
- All current client apps use bundlers (`clients/web/` via Vite,
  `clients/macos/` via electron-vite, `clients/docs/` via Next.js) and
  therefore use `moduleResolution: "Bundler"` with `module: "ESNext"`.
  Bundler-mode apps omit `.js` extensions on imports. If a future client
  compiles without a bundler, use NodeNext with `.js` extensions (matching
  `assistant/`, `gateway/`, `cli/`).
- `clients/docs/` is the public docs site: an SSR Next.js app serving
  www.vellum.ai/docs. See [`clients/docs/AGENTS.md`](docs/AGENTS.md) for its
  URL, theme, and attribution contracts.

## Adding a new client

When adding a new subdirectory under `clients/`, add a corresponding `paths:`
glob to relevant PR/CI workflows in `.github/workflows/`, and add an
appropriate ignore pattern to `.gitignore` if the client produces build
artifacts.

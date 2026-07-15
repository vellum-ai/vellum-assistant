# Apps

Ship a persistent, interactive app from a plugin — a dashboard, a game, a small tool — that renders in the workspace panel. Unlike a tool (which the model calls) or a route (which an external caller hits), an app is a piece of UI the user opens and interacts with directly, and it persists between opens.

An app is a directory under `apps/<app>/`. Each immediate subdirectory of `apps/` is one app: its directory name is the app name and its contents are the source. Like every other surface, a missing `apps/` directory is simply skipped, so a plugin ships an app only if it wants to.

## Two shapes

The app's shape is chosen by what its directory contains.

### Single-file apps

The simplest app is a single `index.html` at the app root. No build step runs: the host serves that HTML directly, and its **inline** scripts are allowed to execute (the page is served with a Content-Security-Policy of `script-src 'self' 'unsafe-inline'`). Sibling files in the app directory (images, stylesheets) are served as assets next to it. Reach for this when the whole app fits in one hand-written HTML file.

### Multi-file apps

Anything without a root `index.html` is treated as a multi-file app: TSX/React source under `src/` that compiles to a sibling `dist/`. The bundler (esbuild) maps `react` / `react-dom` onto `preact/compat`, so you write ordinary React components. Compiled apps load external scripts from `dist/`, so they are served under a stricter CSP (`script-src 'self'` — no inline scripts).

The compile happens off the daemon's hot path: the plugin source watcher builds each app's `src/` into its sibling `dist/` when it detects a change, and that generated `apps/<app>/dist` is excluded from source fingerprinting and drift detection (it is build output, not tracked source). If an app is opened before its `dist/` exists, it is compiled on demand in a throwaway temporary directory — the read-only plugin tree is never written to at open time.

## How apps are addressed

A plugin-bundled app has a deterministic id derived from its location, rather than the opaque UUID a user-created workspace app gets:

```
plugins~<plugin-name>~<app-dir>
```

which maps to `<workspaceDir>/plugins/<plugin-name>/apps/<app-dir>/` (the `apps/` segment is implied). The delimiter is `~`, a URL-unreserved character, so the whole id is a single URL path segment that survives route params and proxies without percent-encoding. When an app is opened, the host reports its origin as `plugin:<plugin-name>`, distinguishing it from a `workspace` app.

## Serving and isolation

An app is served only for an **installed, enabled** plugin: the plugin directory must exist, carry a `package.json` manifest, and not be disabled (no `.disabled` sentinel) — the same gates the plugin's other surfaces pass. Asset requests are confined to the app directory: a path that tries to traverse out of it (`../../package.json`) is rejected, and an id whose segments contain separators or `..` never resolves to a path.

Because a compiled app loads external scripts under the stricter CSP while a single-file app may run inline scripts, keep untrusted or heavier logic in a multi-file app rather than inlining it.

## Read-only apps

A plugin app is part of the plugin's source tree, so it is read-only over the app-management surface: it can be opened and its assets served, but it cannot be deleted or have its data mutated through the management API the way a user-created workspace app can. Its lifecycle is the plugin's: it arrives on install, updates on upgrade, and is removed on uninstall. Any durable state the app needs follows the same rule as the rest of the plugin — it lives in the plugin's `data/` directory, owned by the plugin's lifecycle hooks, not written back into the app source.

## Anatomy of an app

A single-file app is one `index.html`; a multi-file app is a `src/` tree that compiles to `dist/`. A plugin can ship several apps side by side:

```
my-plugin/
└── apps/
    ├── dashboard/            # single-file app
    │   ├── index.html        → served directly (inline scripts allowed)
    │   └── logo.svg          → served as a sibling asset
    └── board/                # multi-file app
        ├── src/
        │   ├── index.html
        │   └── main.tsx       # React (preact/compat under the hood)
        └── dist/              # generated build output (not tracked source)
            ├── index.html
            └── main.js
```

```tsx
// apps/board/src/main.tsx
import { render } from "preact";

render(<div>Compiled Board</div>, document.getElementById("root")!);
```

# Apps

Ship a persistent, interactive app from a plugin — a dashboard, tracker, calculator, data visualization, or slide deck the assistant renders in the workspace panel. An app is a self-contained UI the user opens and interacts with, packaged alongside the plugin's other surfaces.

An app is a directory under `apps/<name>/`. There is no registration step and no manifest entry: the assistant discovers each app by walking the plugin's `apps/` directory on disk, exactly as it does for a plugin's routes. Each immediate subdirectory of `apps/` is one app, and the directory name is the app's name.

## Two app formats

An app is served in one of two formats, chosen by what the directory ships:

- **Single-file.** An `index.html` at the app root. The assistant serves it as-is — inline `<script>` and `<style>` are allowed (the served page's CSP permits `'unsafe-inline'`). Good for a small self-contained page with no build step.
- **Multi-file.** A Preact + TSX project under `src/`, with no root `index.html`. The assistant compiles `src/` into a sibling `dist/` with esbuild and serves the bundled `dist/index.html`. The served page's CSP is stricter (`script-src 'self'`, no inline), matching workspace apps built through the app-builder skill.

The presence of a root `index.html` is what distinguishes the two: `index.html` at the app root ⇒ single-file; otherwise ⇒ multi-file compiled from `src/`.

```
apps/
├── dashboard/            # single-file app
│   └── index.html
└── tracker/              # multi-file app
    ├── src/
    │   ├── index.html    # shell that loads the bundle
    │   ├── main.tsx      # renders <App /> into #app
    │   ├── components/
    │   │   └── App.tsx
    │   └── styles.css
    └── dist/             # compiled output — generated, never hand-written
```

## Compilation and live reload

Multi-file apps are compiled off the assistant's hot path by the plugin source watcher, which already fingerprints plugin source for live reload. When a plugin's source changes, the watcher builds each `apps/<app>/src` into its sibling `apps/<app>/dist` and the new bundle is picked up on the next open — no restart.

- **`dist/` is generated, not source.** You never hand-write or commit `dist/`. It is excluded from the plugin source fingerprint and from install-time drift detection (the `apps/<app>/dist` path is a recognized generated-build directory), so the watcher's own compile never reads as a source change and generated output never shows as drift against the pinned commit. Ship only `src/` (or a root `index.html`) in your repo.
- **The plugin tree is read-only to the assistant.** The daemon never writes into the plugin directory. If a multi-file app is opened before the watcher has produced its `dist/`, the daemon compiles it in a throwaway temp directory to render that open — the persistent `dist/` is still the watcher's job.

## Addressing and serving

A plugin app's id encodes its location rather than being an opaque handle:

```
plugins~<plugin-name>~<app-dir>
```

which maps to `<workspaceDir>/plugins/<plugin-name>/apps/<app-dir>`. The delimiter is `~` (not `/`) so the id stays a single URL path segment. Workspace apps — the ones a user builds with the app-builder skill — instead use an opaque UUID and live under `<workspaceDir>/data/apps/`; a plugin app is resolved by building its path directly from the id.

Once resolved, a plugin app is opened and served exactly like a workspace app: opening it reports an origin of `plugin:<plugin-name>`, its HTML is rendered into the workspace panel, and a multi-file app's compiled JS/CSS is inlined so the page is self-contained. Files bundled next to the app (images, fonts, media) are served from the app's own directory with path traversal rejected, and are addressed at runtime through the same `window.vellum.asset(...)` bridge workspace apps use.

## Discovery and lifecycle

App discovery mirrors the plugin loader's own scan, so an app is visible on exactly the same terms as the plugin's tools, hooks, and routes:

- **Installed plugins only.** A directory contributes apps only if it carries a `package.json` manifest. Stray directories without a manifest are ignored.
- **Disabled plugins contribute nothing.** A plugin with a `.disabled` sentinel serves no apps, matching how its other surfaces are gated.
- **Missing `apps/` is skipped.** A plugin with no `apps/` directory simply bundles no apps, like any absent surface.

## The frontend contract

This reference covers how an app is packaged, compiled, and served as a plugin surface. The *authoring* contract for the app itself — the design system and `--v-*` tokens, the widget library, responsive rules, the `window.vellum` bridge (`fetch`, `asset`, `subscribe`, `sendAction`), and how an app reaches backend data through routes — is owned by the **app-builder** skill, with design quality delegated to **frontend-design**. Build the app's UI by those skills, then drop the resulting directory (single-file `index.html`, or a multi-file `src/`) under your plugin's `apps/`. A plugin that also ships `routes/` can back its app's data with its own namespaced HTTP routes (see [routes.md](routes.md)).

## Anatomy of an app

```
my-plugin/
└── apps/
    └── expenses/
        ├── src/
        │   ├── index.html
        │   ├── main.tsx
        │   ├── components/
        │   │   └── App.tsx
        │   └── styles.css
        └── dist/          # produced by the watcher — do not commit
```

```tsx
// apps/expenses/src/main.tsx
import { render } from "preact";
import { App } from "./components/App";
import "./styles.css";

render(<App />, document.getElementById("app")!);
```

The app above is addressed as `plugins~my-plugin~expenses` and opens in the workspace panel with a `plugin:my-plugin` origin.

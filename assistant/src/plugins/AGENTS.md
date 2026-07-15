# Plugins — Agent Instructions

Rules for code under `assistant/src/plugins/`, including the first-party default plugins in `defaults/`. For authoring or scaffolding a plugin (default or external), follow the `plugin-builder` skill (`skills/plugin-builder/`) — it documents the directory layout, hook contracts, and the `@vellumai/plugin-api` surface.

## Plugin Self-Containment

A plugin owns its state end-to-end. Everything a plugin persists lives in its own storage directory and is created, maintained, and cleaned up through the plugin's lifecycle hooks — never through the assistant's global persistence layer.

- **Storage location**: all durable plugin state lives under `InitContext.pluginStorageDir` (`<pluginDir>/data/` for installed plugins; `<workspaceDir>/plugins-data/<name>/` for defaults and standalone workspace hooks). Do not write plugin state anywhere else in the workspace.
- **Schema in `init`**: open plugin-owned storage (e.g. a SQLite file) and apply the plugin's own schema/migrations in the `init` hook, idempotently — it re-runs on every boot. Never add plugin tables to the main database schema and never register plugin migrations in `assistant/src/persistence/migrations/` / `steps.ts`.
- **Close in `shutdown`**: release storage handles so daemon shutdown and in-place plugin redeploys never leak them.
- **Purge in `conversation-deleted`**: remove per-conversation rows so derived data (captions, caches, logs) does not outlive the conversation that produced it.
- **Fail open**: a plugin whose storage cannot be opened should degrade (e.g. to in-memory behavior), not block boot or the turn.

Canonical example: `defaults/image-fallback` — `hooks/init.ts` opens `caption-cache.sqlite` in the storage dir and ensures its schema, `hooks/shutdown.ts` closes it, `hooks/conversation-deleted.ts` purges the conversation's rows (`src/caption-cache.ts`).

**Grandfathered exception**: `defaults/memory` predates this rule and uses main-database tables via `persistence/schema` / `db-connection`. Do not extend that pattern to other plugins or grow memory's main-DB surface. Enforced by `__tests__/plugin-state-boundary-guard.test.ts`.

Calling the assistant's service APIs from a default plugin (e.g. `persistence/conversation-crud.ts` reads) is fine — the boundary is about _owning state_: plugin tables, plugin migrations, and plugin files belong to the plugin.

## Plugin Execution Context & Credential Scoping

Host APIs that must know _which_ plugin is calling them read the plugin
currently in context from the `AsyncLocalStorage` in
`plugin-execution-context.ts`. The context is established around a plugin's hook
invocation (`pipeline.ts` `runHook`, when `owner.kind === "plugin"`) and around
a plugin tool's `execute()` (`tools/executor.ts`, when the tool's registry owner
is a plugin). Standalone workspace hooks and non-plugin tools establish no
context.

`@vellumai/plugin-api`'s `resolveCredential(ref)` uses this to scope credential
access: when a plugin is in context, it may only resolve credentials whose
`field` equals the plugin's manifest name (`resolve-credential.ts`). Outside any
plugin context the resolver is unscoped (behaves like `assistant credentials
reveal`).

**When adding a new seam that runs plugin-authored code** (a new hook type, a new
plugin surface), wrap the invocation in `runInPluginContext(pluginName, …)` so
scoped host APIs keep enforcing. The context must be set around the call that
_creates_ the plugin's promise, not around the `await`, so the binding
propagates across the plugin's internal awaits.

## Plugin HTTP Routes

A plugin's HTTP routes live on disk under `<pluginDir>/routes/` and are served in the plugin's own namespace at `/x/plugins/<plugin-name>/<path>`. They are **not** a `Plugin` contribution slot and are not wired through the loader or bootstrap — the `/x/*` route dispatcher (`runtime/routes/user-route-dispatcher.ts`) resolves each request against the filesystem at request time, exactly like the workspace `/x/*` user routes it shares code with.

- **Namespace reservation**: the `plugins/<name>/` prefix under `/x/` resolves only against `<workspaceDir>/plugins/<name>/routes/`. A request there never falls back to a workspace `routes/plugins/…` file, so plugins can't collide with workspace routes or each other. A missing file 404s; nothing is registered ahead of time.
- **Authoring**: each route file exports named HTTP-method functions (`export async function GET(request) {…}`), mirroring the workspace user-route convention. Nested directories and `index` files map to sub-paths (`routes/webhooks/incoming.ts` → `/x/plugins/<name>/webhooks/incoming`; `routes/index.ts` → the namespace root). Files are lazily loaded and mtime-cache-busted.
- **Runtime access**: handlers receive the shared `UserRouteContext` (event hub, conversation posting) as a second argument, and may also reach singletons through their `@vellumai/plugin-api` imports.

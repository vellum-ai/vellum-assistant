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

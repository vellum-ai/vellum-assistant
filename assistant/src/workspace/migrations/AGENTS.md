# Workspace Migrations — Agent Instructions

## Self-Containment

Each migration file must be **fully self-contained**. All helper functions, constants, and utilities that a migration needs must be defined inline within the migration file itself — not imported from shared modules outside of `./types.js` and the logger.

- **No external exports.** Migration files must not export anything other than the single `WorkspaceMigration` object. Other code must never import from a migration file.
- **Duplicate rather than share.** If two migrations need the same helper, duplicate it in both files. Migrations are write-once code — they run once per assistant and are never modified after release. Duplication is preferable to coupling.
- **Allowed imports:** `./types.js` (for the `WorkspaceMigration` interface), `./utils.js` (for shared path-resolution helpers like `getVellumRoot()`), `../../util/logger.js` (for structured logging), and Node/Bun runtime built-ins (`node:fs`, `node:path`, `node:crypto`, `bun:sqlite`, etc.). All other dependencies — both project-internal modules and third-party npm packages — must be inlined. Do not import from shared modules like `../../memory/` or `../../config/`, and do not add npm dependencies.
- **Graceful on all platforms.** Migrations run on macOS, Linux, and in Docker. Platform-specific operations must no-op gracefully on unsupported platforms — never throw.
- **Idempotent.** Migrations must be safe to re-run if interrupted. The runner checkpoints state as `"started"` before execution and `"completed"` after, so a crash mid-migration triggers a re-run on next startup.

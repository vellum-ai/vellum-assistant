# Assistant Service — Agent Instructions

For error handling conventions (throw vs result objects vs null), see [docs/error-handling.md](docs/error-handling.md).

Subdirectory-scoped rules live in local AGENTS.md files: `src/cli/`, `src/runtime/`, `src/approvals/`, `src/notifications/`, `src/workspace/migrations/`.

## Adding new environment variables

When you introduce a new env var that the assistant process needs to read at runtime, **update `src/tools/terminal/safe-env.ts`** as well.

`safe-env.ts` maintains the allowlist of env vars that are forwarded to agent-spawned child processes (bash tool, skill sandbox, etc.). Anything not on the list is stripped to prevent credential leakage. If your new var is needed by commands the agent runs, it must be added.

**Default to including it.** If the var doesn't contain secrets (e.g. a URL, a feature flag, a path, a mode string), add it. Only omit it if it carries credential material (tokens, passwords, private keys) — those must stay isolated to CES.

## Daemon startup philosophy

The daemon must **never** block startup due to migration or DB-initialization failures. Individual migration errors are caught, logged, and skipped so that independent later migrations can still succeed. Even `validateMigrationState` is wrapped in a try/catch — a validation failure is logged but does not prevent the daemon from starting. The outer `initializeDb()` call in `lifecycle.ts` is also wrapped so a catastrophic DB open failure results in degraded mode, not a crash.

## Code comments

When writing or updating comments, **do not reference code that has been removed.** Comments should describe the current state of the codebase, not narrate its history. Avoid phrases like "no longer does X", "previously used Y", or "was removed in PR Z" — future readers should not need to understand past implementations to understand the current code.

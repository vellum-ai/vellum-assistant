# Assistant Service — Agent Instructions

For error handling conventions (throw vs result objects vs null), see [docs/error-handling.md](docs/error-handling.md).

Subdirectory-scoped rules live in local AGENTS.md files: `src/cli/`, `src/runtime/`, `src/approvals/`, `src/notifications/`, `src/workspace/migrations/`.

## Adding new environment variables

When you introduce a new env var that the assistant process needs to read at runtime, **update `src/tools/terminal/safe-env.ts`** as well.

`safe-env.ts` maintains the allowlist of env vars that are forwarded to agent-spawned child processes (bash tool, skill sandbox, etc.). Anything not on the list is stripped to prevent credential leakage. If your new var is needed by commands the agent runs, it must be added.

**Default to including it.** If the var doesn't contain secrets (e.g. a URL, a feature flag, a path, a mode string), add it. Only omit it if it carries credential material (tokens, passwords, private keys) — those must stay isolated to CES.

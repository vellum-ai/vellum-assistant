# Assistant Service — Agent Instructions

For error handling conventions (throw vs result objects vs null), see [docs/error-handling.md](docs/error-handling.md).

Subdirectory-scoped rules live in local AGENTS.md files: `src/cli/`, `src/runtime/`, `src/approvals/`, `src/notifications/`, `src/workspace/migrations/`.

## Adding new environment variables

When you introduce a new env var that the assistant process needs to read at runtime, **update `src/tools/terminal/safe-env.ts`** as well.

`safe-env.ts` maintains the allowlist of env vars that are forwarded to agent-spawned child processes (bash tool, skill sandbox, etc.). Anything not on the list is stripped to prevent credential leakage. If your new var is needed by commands the agent runs, it must be added.

**Default to including it.** If the var doesn't contain secrets (e.g. a URL, a feature flag, a path, a mode string), add it. Only omit it if it carries credential material (tokens, passwords, private keys) — those must stay isolated to CES.

## Daemon startup philosophy

The daemon must **never** block startup under _any circumstance_. All possible errors should be logged so that the assistant can recover from it's corrupted state after the fact.

## Post-execution hooks

Tool post-execution hooks (`src/daemon/tool-side-effects.ts`) run after a tool executor returns. They are an **observation-and-notification layer** only: refresh client-side state, broadcast events, kick off orthogonal background work (e.g. icon generation). Hooks must not re-do work the executor already performed, and must not attempt recovery when the executor failed — failures surface in the tool result for the LLM to act on.

Do not coordinate hook behaviour by re-parsing the tool's JSON response to infer what the executor did (e.g. "if field X is missing, retry step Y"). That couples the LLM-facing response shape to internal daemon logic and breaks silently when the response shape evolves. Keep the hook's logic independent of the result payload, or if the hook genuinely needs executor-internal state, pass it through a typed side channel — never through a JSON round-trip.

Shared mutable resources written by more than one caller (e.g. `dist/` directories produced by `compileApp()`) must be serialised per-resource so concurrent callers cannot race on `rm -rf` + write sequences.

## IPC route registration

IPC routes belong to the IPC server, not to its consumers. When adding a new route, define it in `src/ipc/routes/` and register it in the route index (`src/ipc/routes/index.ts`). The server's constructor should be the single place that wires routes — callers that instantiate or start the server should not need to call separate `register*Deps()` functions.

Today, some routes (e.g. `secrets`, `credential-prompt`) use a module-level dependency-injection pattern where the daemon server calls `registerFooDeps()` at startup. This is a known antipattern — it forces consumers to know about route internals and creates implicit ordering requirements. New routes should avoid this pattern. Existing dep-injection routes should be migrated to accept deps through the server constructor or a server-level `configure()` call.

## Code comments

When writing or updating comments, **do not reference code that has been removed.** Comments should describe the current state of the codebase, not narrate its history. Avoid phrases like "no longer does X", "previously used Y", or "was removed in PR Z" — future readers should not need to understand past implementations to understand the current code.

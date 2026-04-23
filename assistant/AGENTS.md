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

Tool post-execution hooks (`src/daemon/tool-side-effects.ts`) run after a tool executor returns. Treat the executor's output as authoritative: hooks must not re-do work the executor already completed, especially destructive work like wiping and rebuilding a generated-output directory. If the hook needs to recover from a failed executor step, gate the recovery on an explicit failure signal in the tool result (e.g. a `compile_errors` field) rather than running unconditionally.

Shared mutable resources written by more than one caller (e.g. `dist/` directories produced by `compileApp()`) must be serialised per-resource so concurrent callers cannot race on `rm -rf` + write sequences.

## Code comments

When writing or updating comments, **do not reference code that has been removed.** Comments should describe the current state of the codebase, not narrate its history. Avoid phrases like "no longer does X", "previously used Y", or "was removed in PR Z" — future readers should not need to understand past implementations to understand the current code.

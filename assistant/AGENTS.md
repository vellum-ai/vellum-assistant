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

## Route architecture: shared ROUTES array

Routes in `src/runtime/routes/` are being migrated to a **shared `ROUTES` array** that serves as the single source of truth for both the HTTP server and the IPC server. Each route module exports `ROUTES: RouteDefinition[]` (from `routes/types.ts`), and the aggregator `routes/index.ts` collects them.

- **Handlers are transport-agnostic.** They accept optional params and return plain data (objects/arrays/primitives). They never import HTTP types, return `Response` objects, or reference `Request`. Throw `RouteError` subclasses (from `routes/errors.ts`) for error cases — the adapters map these to wire-format errors.
- **HTTP adapter** (`routes/http-adapter.ts`): wraps handlers in `Response.json()`, maps `RouteError` to HTTP status codes.
- **IPC adapter** (`ipc/routes/route-adapter.ts`): maps `operationId` → IPC method name, passes handler through directly.
- **Dual exposure is intentional.** Every route in the shared `ROUTES` array is served over both HTTP and IPC. This is by design — it enables the gateway to call the daemon over IPC instead of HTTP, eliminating JWT token exchange on those paths (ATL-309 → ATL-311). Do not flag IPC exposure of shared routes as unintentional surface area.
- **`RouteDefinition` carries everything:** `operationId`, `endpoint`, `method`, `handler`, `policyKey?`, `summary?`, `description?`, `tags?`, `responseBody?`. The HTTP adapter reads all fields; the IPC adapter only needs `operationId` and `handler`.

### IPC-only routes

Some routes are IPC-only (defined in `src/ipc/routes/`, not in the shared array). These are tool/CLI-specific methods (e.g. `wake_conversation`, `upsert_contact`) that have no HTTP counterpart. They follow the existing pattern: define in `src/ipc/routes/`, register in `src/ipc/routes/index.ts`.

The module-level dependency-injection pattern (`registerFooDeps()`) used by some IPC routes is a known antipattern. New IPC-only routes should avoid it.

## Code comments

When writing or updating comments, **do not reference code that has been removed.** Comments should describe the current state of the codebase, not narrate its history. Avoid phrases like "no longer does X", "previously used Y", or "was removed in PR Z" — future readers should not need to understand past implementations to understand the current code.

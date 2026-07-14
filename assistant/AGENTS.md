# Assistant Service — Agent Instructions

For error handling conventions (throw vs result objects vs null), see [docs/error-handling.md](docs/error-handling.md).

Subdirectory-scoped rules live in local AGENTS.md files: `src/cli/`, `src/runtime/`, `src/approvals/`, `src/notifications/`, `src/plugins/`, `src/workspace/migrations/`.

## Adding new environment variables

When you introduce a new env var that the assistant process needs to read at runtime, **update `src/tools/terminal/safe-env.ts`** as well.

`safe-env.ts` maintains the allowlist of env vars that are forwarded to agent-spawned child processes (bash tool, skill sandbox, etc.). Anything not on the list is stripped to prevent credential leakage. If your new var is needed by commands the agent runs, it must be added.

**Default to including it.** If the var doesn't contain secrets (e.g. a URL, a feature flag, a path, a mode string), add it. Only omit it if it carries credential material (tokens, passwords, private keys) — those must stay isolated to CES.

`CES_LOCAL_SOCKET` is intentionally included despite the socket exposing credential RPCs — assistant subprocesses are expected to reach CES. Credential protection is rules-based access control inside CES, not socket-path secrecy (see root `AGENTS.md`).

## Daemon startup philosophy

The daemon must **never** block startup due to **subsystem** failures (DB, Qdrant, plugins, feature flags, etc.). If an individual subsystem fails, log the error and continue in degraded mode so the process remains reachable for health checks and diagnostics.

**Exception — duplicate daemon detection:** If the daemon cannot establish **any** client-facing transport because another daemon already holds both the IPC socket and HTTP port, it must exit immediately. A daemon with no transport is unmanageable (invisible to health checks, unreachable by stop commands) yet still runs background jobs (scheduler, memory worker, background wake) against the shared database, causing duplicate side effects.

## DB migration readiness gating

DB migrations run asynchronously during startup: the HTTP server binds (so `/healthz` answers) **before** `initializeDb()` finishes, and readiness is tracked in `src/daemon/daemon-readiness.ts` (`setDbMigrating` → `setDbReady`/`setDbMigrationFailed`). **No code may touch the database — `getDb()`, `getSqlite()`, drizzle queries, raw SQL — unless `getDbMigrationReadiness().ready` is true or its execution provably starts after `initializeDb()` settles in `daemon/lifecycle.ts`.** Querying earlier hits a partially-migrated schema ("no such table"/"no such column").

Existing enforcement, which new code must not bypass:

- **HTTP** requests are gated per-route in `runtime/http-server.ts`; **IPC** methods in `ipc/assistant-server.ts`; both derive their exempt set from `DB_MIGRATION_READINESS_EXEMPT_OPERATIONS` in `daemon-readiness.ts` (health/liveness probes only — anything exempted must never touch the DB).
- **Message sinks** (`processMessage`, `processMessageInBackground`) guard via `assertDbMigrationsReadyForTurn()`.
- **Background sweeps** are started by lifecycle only after migrations settle (`startRuntimeHttpServerBackgroundSweeps`).
- The **migration-repair surface** (`admin/rollback-migrations` plus all `migrations/import*` / preflight transports and their job-status route) is additionally allowed in the terminal `failed` state only — see `DB_MIGRATION_FAILED_STATE_EXEMPT_OPERATIONS`. Never widen this to the `running` state: a rollback or import would race the in-flight migration runner. A successful repair does not clear the failed latch — the daemon must be restarted to re-run migrations and become ready.

When adding a new background job, timer, signal handler, or transport entry point that reaches the DB, either start it after `initializeDb()` settles in lifecycle, or check `getDbMigrationReadiness().ready` (and skip/queue when unready) inside it. Do not add readiness waits to probe endpoints — `/healthz` must stay static and instant.

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

### CLI ↔ daemon communication protocol

The CLI and daemon communicate over a Unix domain socket using **length-prefixed binary framing**: each frame is a 4-byte big-endian length followed by a payload. Messages use a JSON envelope `{ id, method, params?, headers? }` for requests and `{ id, result?, error?, headers? }` for responses.

Three response shapes are supported:

- **JSON-only**: a single JSON frame (no `content-length` or `transfer-encoding` header).
- **Binary**: a JSON envelope with `headers: { "content-length": "<n>" }` followed by one binary frame of exactly `n` bytes.
- **Chunked streaming**: a JSON envelope with `headers: { "transfer-encoding": "chunked" }` followed by one or more binary frames, terminated by a zero-length frame.

The server auto-detects legacy newline-delimited JSON from old CLI clients and handles it transparently. New code must use length-prefixed framing via `writeMessage()` / `IpcFrameReader` in `src/ipc/ipc-framing.ts`.

### CLI ↔ daemon version skew

The CLI and daemon are always shipped and upgraded together — there is no version skew between them. When migrating a route to the shared `ROUTES` array and updating the CLI to send structured params, backward compatibility with older CLI versions is **not required**. Do not add compat shims for flat-param callers that no longer exist.

### IPC-only routes

Some routes are IPC-only (defined in `src/ipc/routes/`, not in the shared array). These are tool/CLI-specific methods (e.g. `wake_conversation`, `upsert_contact`) that have no HTTP counterpart. They follow the existing pattern: define in `src/ipc/routes/`, register in `src/ipc/routes/index.ts`.

The module-level dependency-injection pattern (`registerFooDeps()`) used by some IPC routes is a known antipattern. New IPC-only routes should avoid it.

## Telemetry wire contract

`src/telemetry/telemetry-wire.generated.ts` is generated from the platform's telemetry ingest serializers and auto-synced here on platform merges (the platform's `sync-telemetry-wire.yaml` workflow). **Never edit it by hand** — contract changes belong in `vellum-assistant-platform` at `django/app/assistant/self_hosted_local/serializers.py`.

`src/telemetry/types.ts` is the override layer on top of it: simple events flow through `WireEventMap` without restating fields; events where the daemon's type is intentionally richer live in `Overrides`, each pinned to the wire type by an `AssertNarrows` compile-time guard; daemon-only events live in `Extensions`. A red `AssertNarrows` or a failing `types.test.ts` on a sync PR means the platform contract moved — reconcile the override to the new wire shape, don't loosen the guard.

Pre-flush validation (`src/telemetry/telemetry-wire-validation.ts`) checks outgoing events against the wire schemas and logs any the server would silently drop; it is observability only and never blocks or mutates the batch.

## Code comments

When writing or updating comments, **do not reference code that has been removed.** Comments should describe the current state of the codebase, not narrate its history. Avoid phrases like "no longer does X", "previously used Y", or "was removed in PR Z" — future readers should not need to understand past implementations to understand the current code.

## Test machinery isolation

**Test machinery — the test preload, the preload verifier, and shared test helpers — must not reach into `src/`.** Regular `*.test.ts` files may import production modules they exercise (the module under test, types, sibling utilities) like any normal consumer; the strict no-`src/` rule applies only to infrastructure that runs _before_ the per-test workspace override is established.

The rule exists because test machinery and production code have **inverted invariants**: production assumes the workspace exists and is real; tests assume the workspace is a per-process temp dir that's safe to destroy. When a _preload_ or _helper_ reaches into `src/` to set up state, it pulls in import-time side effects before the workspace override is set — and a future change to either side can silently break the isolation the helper was supposed to provide. The May 2026 DB-ghost incidents (3 in 4 days) all traced back to preload-time code touching production state through this kind of coupling. Per-test-file imports run after preload and inside the workspace override, so they don't have this problem.

Concretely:

- **Test helpers** (e.g. `src/__tests__/*-test-helpers.ts`) use only node stdlib, `bun:test`, and sibling helpers. If they need to manipulate shared state that production code also reads, both sides declare a typed slot under `globalThis.vellumAssistant.*` and read/write that slot independently. The slot shape is duplicated by design — the helper and the production module both reference the namespace, neither imports the other.
- **The test preload** (`src/__tests__/test-preload.ts`) is the strictest: it must not import from `src/` at all. Its only static imports are node stdlib, `bun:test`, and helpers in `src/__tests__/`. Importing from a source module risks running its import-time side effects before the workspace override is set.
- **The preload verifier** (`src/__tests__/test-preload-verifier.ts`) runs after the main preload and asserts the override took effect (`VELLUM_WORKSPACE_DIR` must resolve under `os.tmpdir()`).
- **Destructive ops** (e.g. `rmSync(dbPath, ...)`) in tests must call `assertNotLiveDb(path)` from `src/__tests__/assert-not-live-db.js` immediately before the destructive call. The check is a per-callsite belt to the preload-verifier suspenders.

When in doubt: **if a piece of test infrastructure (preload / helper / verifier) can live in `__tests__/` without reaching into `src/`, it must.** Reach for source-code coupling only when there is no `__tests__/`-only alternative that achieves the same invariant. This restriction is about preload-time infrastructure, not the test files themselves.

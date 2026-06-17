# Assistant Service — Agent Instructions

For error handling conventions (throw vs result objects vs null), see [docs/error-handling.md](docs/error-handling.md).

Subdirectory-scoped rules live in local AGENTS.md files: `src/cli/`, `src/runtime/`, `src/approvals/`, `src/notifications/`, `src/workspace/migrations/`.

## Adding new environment variables

When you introduce a new env var that the assistant process needs to read at runtime, **update `src/tools/terminal/safe-env.ts`** as well.

`safe-env.ts` maintains the allowlist of env vars that are forwarded to agent-spawned child processes (bash tool, skill sandbox, etc.). Anything not on the list is stripped to prevent credential leakage. If your new var is needed by commands the agent runs, it must be added.

**Default to including it.** If the var doesn't contain secrets (e.g. a URL, a feature flag, a path, a mode string), add it. Only omit it if it carries credential material (tokens, passwords, private keys) — those must stay isolated to CES.

## Daemon startup philosophy

The daemon must **never** block startup due to **subsystem** failures (DB, Qdrant, plugins, feature flags, etc.). If an individual subsystem fails, log the error and continue in degraded mode so the process remains reachable for health checks and diagnostics.

**Exception — duplicate daemon detection:** If the daemon cannot establish **any** client-facing transport because another daemon already holds both the IPC socket and HTTP port, it must exit immediately. A daemon with no transport is unmanageable (invisible to health checks, unreachable by stop commands) yet still runs background jobs (scheduler, memory worker, background wake) against the shared database, causing duplicate side effects.

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

## Channel Identity & Trust Classes

**`TrustClass`** emitted by `actor-trust-resolver.ts:280-292`:

| Value | Rank |
|---|---|
| `guardian` | 4 — assistant owner |
| `trusted_contact` | 3 — verified across at least one channel |
| `unverified_contact` | 2 — contact row exists with status `unverified`/`pending` |
| `unknown` | 1 — no matching contact |
| `blocked` / `revoked` | 0 — short-circuit before classification, hard-deny regardless of floor |

**`AdmissionPolicy`** (gateway-owned, attached to inbound via `sourceMetadata.admissionPolicy`):

| Value | Floor | Behavior |
|---|---|---|
| `no_one` | 5 | Gateway kill switch — deny pre-forward, including guardian. |
| `guardian_only` | 4 | |
| `trusted_contacts` | 3 | **Default** when the gateway's row is missing. |
| `any_contact` | 2 | |
| `strangers` | 1 | |

Gate: `TRUST_CLASS_RANK[trustClass] >= ADMISSION_FLOOR[policy]` → admit.

**Locked invocation rules** (§8 decisions, 2026-06-16):

- Channels `vellum`, `platform`, `a2a` are exempt — the runtime short-circuits to `admitted: true` *before* any floor check. The gateway rejects `PUT /v1/channel-admission-policy/:channelType` with 403 for these ids. Do not add floor checks to `vellum`: it's the local desktop/macOS client path — a guardian setting `no_one` on it would lock themselves out of their own UI.
- `unverified_contact` is admission-only — downstream it follows `trusted_contact` semantics. Six explicit `=== "trusted_contact"` widenings implement the propagation (Wave B plan §5.1): `actor-trust-resolver.ts:280`, `trust-context-resolver.ts:74`, `tool-approval-handler.ts:512`, `guardian-approval-interception.ts:226`, `disk-pressure-policy.ts:82`, `message-provenance.ts:27`. `isUntrustedTrustClass()` widens to include `unverified_contact` — single helper edit propagates the rule to 10 production call sites.
- Silent denials: when runtime denies at `trusted_contacts`/`guardian_only`, fire no Slack DM or email upgrade challenge. Reuse `acl-enforcement.ts` canned-reply + guardian-notify pipeline. Only `any_contact`/`strangers` floors may surface the upgrade UX — those admit once verification completes.
- Per-conversation override (`inbound.conversationOverride: AdmissionPolicy | null`) may lift the type-level floor for a specific conversation. If set and ≠ type-floor, override prevails. P5 client UI is the writer.
- Blocked / revoked contacts use rank 0 regardless and never reach the floor comparison — `acl-enforcement.ts:454` re-checks `resolvedMember.channel.status` before ACL and emits `member_blocked` / `member_revoked` short-circuits.

`isUntrustedTrustClass()` widens to include `unverified_contact` — centralizes the "treat like trusted_contact downstream" rule into every consumer of the helper. Add a new trust class by: (a) updating the type union in `actor-trust-resolver.ts:46`, (b) adding the rank to `TRUST_CLASS_RANK`, (c) extending `parseProvenanceTrustClass` in `message-provenance.ts:27-29` so historical rows round-trip, and (d) auditing the 6 explicit-branch sites in §5.1 for which arm they belong to.

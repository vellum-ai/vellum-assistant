# Audit: Can Conversations run in their own process?

**Question:** What singletons and in-memory state in the conversation runner and agent
loops would make it hard to run Conversations in a process separate from the main daemon?

**Date:** 2026-06-26
**Method:** Read the core lifecycle files directly; fanned out four sweeps over the agent
loop, the event/interaction layer, shared service singletons, and the daemon background
subsystems. Load-bearing claims (event hub, pending-interactions, DB singleton) verified by
hand. Line numbers from the broad sweep are approximate where noted.

> Scope note: "separate process" and "off the main thread" are the same problem here. A
> `worker_thread` shares no JS heap with the main thread (barring `SharedArrayBuffer`), and
> `bun:sqlite`/MCP/Playwright handles are not transferable across either a worker or a child
> process. So every finding below applies equally to a worker-thread split and a
> child-process split.

---

## TL;DR verdict

The agent loop is **not** isolated behind an interface today — it is woven into the daemon
through **in-memory shared state at four levels**, and all four would break at a process
boundary:

1. **The live-object registry.** Conversations *are* a module-level `Map<string, Conversation>`
   of live JS objects (`conversation-registry.ts`). Everything — routes, scheduler,
   heartbeat, evictor, subagents — finds a conversation by id and **calls methods on the
   object directly**. A process boundary turns every one of those direct calls into IPC.
2. **Event delivery & user interaction is in-process pub/sub + deferred promises.** The loop
   streams to clients through the `assistantEventHub` singleton (an in-memory `Set` of
   subscribers) and *blocks tools on unresolved Promises whose resolvers live in a
   module-level `Map`* (`pending-interactions.ts`, the host-proxy `pending` maps, the
   `PermissionPrompter`). The HTTP handler that receives the user's approval calls the
   resolver **in the same process**. Split the loop out and every approval / secret /
   host-bash / host-browser call hangs forever.
3. **Process-wide service singletons.** DB handles (`globalThis.vellumAssistant.dbSingletons`),
   the provider registry + shared rate-limit array, the MCP manager, the feature-flag cache,
   the config cache, and the subagent manager are all per-process in-memory state the loop
   reads on every turn.
4. **Per-conversation in-memory state held in daemon module maps.** `ContextWindowManager`
   (`managersByConversation`), `ConversationGraphMemory`, the compaction circuit breaker, and
   the per-turn event-handler state are all keyed by conversation id in daemon-side modules.
   These are fine to *move* with the loop (they're per-conversation), but they live in the
   wrong process today.

The good news: **CES (credentials) is already a separate process reached over IPC**, the
`wake_conversation` IPC method already exists, and message persistence already funnels
through a dispatch layer. CES is the template for how the rest should look.

---

## A. Event delivery & user-interaction resolution — the hardest blocker

This is the category that makes a naive split *hang*, not just misroute. The loop does not
"return" events — it pushes them through an in-memory hub, and it *awaits Promises that a
different code path resolves*.

| Location | Kind | What it is | Why a process split breaks it |
|---|---|---|---|
| `runtime/assistant-event-hub.ts:152` (`export const assistantEventHub`) | In-memory pub/sub | `AssistantEventHub` holds `private readonly subscribers = new Set<SubscriberEntry>()` (callbacks). SSE route subscribes; the loop publishes via `broadcastMessage()`. | If the loop is in process B and SSE subscribers register with the hub in process A, B's hub has no subscribers — published events reach nobody. |
| `runtime/pending-interactions.ts:136` (`const pending = new Map`) | Deferred promise | Holds `rpcResolve`/`rpcReject` for every confirmation, secret, host-bash/file/cu/browser/app-control request, keyed by `requestId`. | The tool `await`s a Promise whose `resolve` lives in B's Map. `POST /v1/confirm` (process A) looks up `requestId` in *A's* Map, finds nothing → the tool never unblocks. |
| `permissions/prompter.ts` (`PermissionPrompter.prompt()`) | Deferred promise | Creates the approval Promise, registers `rpcResolve` in `pending-interactions`, emits `confirmation_request` via `sendToClient`. | Same as above: resolver and HTTP responder must be co-located. |
| `daemon/host-proxy-base.ts:~95` (`protected pending = new Map`) | Deferred promise | Base class for all host proxies; `dispatchRequest()` stores `(resolve, reject)` per `requestId`; `POST /v1/host-*-result` calls `proxy.resolveResult()`. | The proxy singleton in B holds the pending Promise; the result POST hits A. Cross-process the two instances never meet → host tools time out. |
| `daemon/host-bash-proxy.ts` etc. (`static instance`) | Singleton | Host proxies are process-global singletons. | Two processes = two instances with disjoint `pending` maps. |
| `daemon/conversation.ts:268` (`sendToClient`) + `:179` re-bind in `conversation-store.ts` | In-memory callback | Each `Conversation` holds a `sendToClient(msg)` closure wired to `broadcastMessage` → the local hub, re-bound on every inbound message. | The callback captures *this process's* hub. If routes (A) and loop (B) both re-bind the same logical conversation, they fight over which hub gets events. |
| `runtime/chrome-extension-registry.ts` | Singleton | `(guardianId, clientInstanceId)` → live WebSocket. Browser tools route frames through it. | WebSockets are owned by whichever process accepted them (the HTTP server); the loop in B can't reach them. |

**What this category needs to survive a split:** an IPC event broker that (a) relays loop
output events to whichever process holds the SSE subscribers, and (b) turns "await a user
decision" into a request/response over IPC — the loop process issues an interaction request
and blocks on an IPC reply; the HTTP process receives the user's POST and sends the reply
frame back. In other words, `pending-interactions` and the host-proxy `pending` maps must be
replaced by a correlation-id channel that spans the process boundary. This is the bulk of
the work.

---

## B. Direct method calls on live Conversation objects

Because conversations are live objects in a shared Map, the rest of the daemon calls their
methods synchronously. Every call site below becomes an IPC round-trip after a split.
(Line numbers approximate — from the sweep.)

| Caller | Representative calls | Severity |
|---|---|---|
| `runtime/routes/conversation-routes.ts` (send path) | `setProcessing()`, `persistUserMessage()`, `enqueueMessage()`, `runAgentLoop()` | HIGH |
| `daemon/process-message.ts:~517–577` | `persistUserMessage()`, `runAgentLoop()`, `updateClient()` | HIGH |
| `runtime/agent-wake.ts` (`wakeAgentForOpportunity`) | `setProcessing()`, `maybeCompact()`, `messages.push()`, `agentLoop.run()`, `drainQueue()`, `setTrustContext()` | HIGH |
| `schedule/scheduler.ts` (~15s tick) | wakes a live conversation via `wakeAgentForOpportunity()` | HIGH |
| `heartbeat/heartbeat-service.ts` | same wake path | HIGH |
| `daemon/conversation-evictor.ts:~183` (60s sweep) | iterates the registry Map, `isProcessing()`, `dispose()` | HIGH |
| `subagent/manager.ts` | constructs child `Conversation`s, `runAgentLoop()`, `enqueueMessage()`, `dispose()`, `abort()`; indexes them in `subagentConversations` | HIGH |
| `daemon/conversation-store.ts` | `getOrCreateConversation()` constructs the object, wires provider/rate-limit/system-prompt, `dispose()` | HIGH |

The send path, the two timer-driven wake sources (scheduler, heartbeat), eviction, and
subagent spawning are the five subsystems that would each need an IPC verb
(`enqueue_message`, `wake`, `evict`, `spawn_subagent`, …) instead of a method call. The
`wake_conversation` IPC method already exists as a partial precedent.

---

## C. Process-wide service singletons the loop reads every turn

| Singleton | Location | Cross-process difficulty | Notes |
|---|---|---|---|
| DB handles (`getDb`, `getSqlite`, `getMemorySqlite`, `getLogsSqlite`) | `memory/db-singleton.ts` (`globalThis.vellumAssistant.dbSingletons`), `memory/db-connection.ts` | **MED** | WAL + `synchronous=FULL` means a second process *can* open the same files, but each process has its own connection, prepared-statement cache, and WAL writer. Write contention and checkpoint coordination need thought; reads are fine. |
| Provider registry (`providers` / `connectionProviders` Maps) | `providers/registry.ts:~29` | **HIGH** | Pure in-memory; the loop process must run `initializeProviders()` itself (redundant credential/managed-proxy handshakes). No IPC binding. |
| Shared rate-limit timestamps | `providers/ratelimit.ts`, `daemon/server.ts:~78` (`sharedRequestTimestamps`), injected via `initConversationLifecycle()` | **HIGH** | A `number[]` shared by reference across providers and subagents in one process. A second process gets a *separate* bucket → the global request/min budget is silently doubled. Needs a shared rate-limit authority. |
| MCP manager + clients | `mcp/manager.ts:~164` (`instance`, `clients` Map) | **HIGH** | Each client is a stdio connection to an MCP subprocess. The loop process must establish its own connections; can't share live stdio pipes. |
| Feature-flag cache | `config/feature-flag-cache.ts` (`globalThis.vellumAssistant.featureFlagCache`) | **HIGH** | Fetched from the gateway at init; second process must re-fetch and won't see live updates without an invalidation signal. |
| Config cache | `config/loader.ts:~25` (`cached`, signature check) | **MED** | File-backed and re-readable, but not live-watched — a config write in one process isn't seen by the other until cache invalidation. |
| Subagent manager | `subagent/index.ts` (`_instance`) | **HIGH** | Holds child conversations + the shared rate-limit ref; would naturally live with the loop. |
| CES credential client | `credential-execution/`, `security/secure-keys.ts` (`_cesClient`) | **LOW — already IPC** | CES is a separate process reached over stdio RPC. Either process can connect. **This is the template** for the rest. |
| Browser manager (Playwright) | `tools/browser/.../browserManager` | **MED** | In-process Playwright; whichever process runs the tool owns the browser. Fine if it co-locates with the loop. |

---

## D. Per-conversation state held in daemon module maps

These are *per-conversation* (so they belong with the loop) but currently live in
daemon-side module singletons keyed by conversation id. They must travel with the loop, not
stay behind:

| State | Location | Note |
|---|---|---|
| `ContextWindowManager` per conversation | `plugins/defaults/compaction/manager-store.ts:~21` (`managersByConversation` Map) | Compaction/token-budget state read before every provider call. |
| `ConversationGraphMemory` | `daemon/conversation.ts:~550` | Memory-v3 active-node tracking; persisted post-turn. |
| Compaction circuit breaker | `agent/compaction-circuit.ts` (field on the loop) | Cross-turn failure counters; must persist across turns of the *same* conversation. |
| Per-turn event-handler state | `daemon/conversation-agent-loop.ts:~521` (`createEventHandlerState()`) | Tool-id/message-id/token bookkeeping mutated throughout a turn; closure-captured by the event handler. |
| `surfaceState`, transport hints, trust/auth context, `abortController` | `daemon/conversation.ts` fields | Live per-conversation control state the routes mutate directly today. |
| Sentry conversation scope | `conversation-agent-loop.ts:~539` | Process-global observability scope set per turn — would desync in a worker. |

---

## What already survives a split (build on these)

- **CES is already out-of-process over IPC** — the existing proof that a hot-path dependency
  can be remoted cleanly. Copy this shape for providers/flags.
- **DB is file-backed (WAL)** — a second process can open it; this is the easy half of state.
- **`wake_conversation` IPC method exists** (`ipc/routes/`, `daemon/wake-conversation-ops.ts`)
  — partial precedent for driving a conversation by message instead of by method call.
- **Message persistence funnels through a dispatch layer** (`conversation-agent-loop-handlers.ts`),
  so the write path already has a seam to make async.
- **The registry is deliberately a leaf module** (type-only import of `Conversation`) — it's
  already structured to be the single choke point for "find the live conversation," which is
  exactly the seam an IPC router would replace.

---

## Recommended split line

**Conversation process** (owns the live objects and everything per-conversation):
the `conversations` + `subagentConversations` Maps, the agent loop, `ContextWindowManager` /
graph memory / compaction circuit, the evictor (sweeps its *own* registry), subagent
spawning (children are siblings), and the host-proxy `pending` maps + browser manager (tools
run here).

**Daemon / HTTP process** (owns client transport and scheduling):
the HTTP/SSE server, `assistantEventHub`, the scheduler and heartbeat timers. These reach the
conversation process via IPC verbs: `enqueue_message`, `wake`, `evict`, `abort`,
`spawn_subagent`.

**The two cross-cutting hazards** that aren't a clean "move it to one side":
1. **Event + interaction bridge** (Category A) — needs a correlation-id IPC channel so the
   loop can stream events out and *block on user decisions* across the boundary. Biggest task.
2. **Rate limiting** (Category C) — the shared `sharedRequestTimestamps` array must become a
   shared authority (IPC-served token bucket), or per-process budgets will double-spend the
   provider rate limit.

Everything else is mechanical: re-`init` the provider registry, MCP clients, config, and
feature-flag caches in the loop process (each process re-derives them from CES + DB + gateway,
exactly as the daemon does today), and convert the ~8 direct-method call sites in Category B
into IPC verbs.

---

## Severity-ranked blocker summary

| # | Blocker | Category | Severity |
|---|---|---|---|
| 1 | Deferred-promise user interactions (`pending-interactions`, host-proxy `pending`, prompter) resolved by in-process HTTP handlers | A | **HIGH** |
| 2 | `assistantEventHub` in-memory subscriber Set + per-conversation `sendToClient` callback | A | **HIGH** |
| 3 | Live `Conversation` objects in a module Map; routes/scheduler/heartbeat/evictor/subagents call methods directly | B | **HIGH** |
| 4 | Shared rate-limit array (`sharedRequestTimestamps`) → per-process budget double-spend | C | **HIGH** |
| 5 | Provider registry / MCP manager / feature-flag cache in-process singletons | C | **HIGH** |
| 6 | Host-proxy + chrome-extension singletons own client connections in the HTTP process | A | **MED–HIGH** |
| 7 | Per-conversation managers in daemon module maps (context window, graph memory, compaction circuit, per-turn state) | D | **MED** (move with loop) |
| 8 | DB connection per process (WAL write contention, no shared statement cache) | C | **MED** |
| 9 | Config cache / Sentry scope not live-synced across processes | C/D | **LOW–MED** |
| 10 | CES already IPC; DB file-backed; `wake_conversation` exists | — | **Already OK** |

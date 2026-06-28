/**
 * `SkillHost` — the runtime-injected contract a skill receives instead of
 * reaching into `assistant/` directly.
 *
 * This module is type-only. No runtime code lives here — every declaration
 * is an `interface` or `type`, so importing from this file contributes zero
 * bytes to a compiled bundle and keeps the contracts package free of any
 * dependency on `assistant/`.
 *
 * ### Opaque placeholder types
 *
 * Several types referenced by `SkillHost` (LLM provider handles, STT/TTS
 * provider handles, memory wake-request shape, speaker tracker, etc.) have
 * their authoritative definitions in `assistant/src/`. Moving every one of
 * them into this neutral package would pull in a large transitive closure
 * (CES contracts, config schemas, per-domain message types, …) that the
 * skill-isolation plan explicitly wants to avoid for the PR-6 slice.
 *
 * Instead, this file declares **opaque placeholder interfaces / type
 * aliases** for the daemon-internal shapes. Skills pass these values
 * through the host API without inspecting their internals; the daemon-side
 * implementation of `SkillHost` (see `DaemonSkillHost` in PR 7) narrows
 * them back to their concrete types at its boundary. This mirrors the
 * pattern already used by `tool-types.ts` for `ToolContext` fields like
 * `cesClient` and `hostBashProxy`.
 *
 * ### What lives where
 *
 * - Surface-level payload types that skills construct or read
 *   (`AssistantEvent`, `ServerMessage`, `Tool`, `DaemonRuntimeMode`) live
 *   in sibling files of this package and are imported here.
 * - Daemon-internal handles (`Provider`, `TtsProvider`, `SttSpec`, …) are
 *   opaque in this file.
 * - Structural helpers with no daemon dependency (`Logger`, `Filter`,
 *   `Subscription`, `SkillRoute`, `SkillRouteHandle`) are declared here in
 *   full.
 */

import type { AssistantEvent } from "./assistant-event.js";
import type { DaemonRuntimeMode } from "./runtime-mode.js";
import type { ServerMessage } from "./server-message.js";
import type { Tool } from "./tool-types.js";

// ---------------------------------------------------------------------------
// Logger — minimal structural interface
// ---------------------------------------------------------------------------

/**
 * Minimal structural logger. Compatible with the daemon's `getLogger`
 * return type at its use sites: four severity methods, each accepting a
 * human-readable message and an optional metadata payload. Skills use
 * `host.logger.get(<name>)` to obtain an instance; the name is opaque and
 * purely for log-scoping on the host side.
 */
export interface Logger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

export interface LoggerFacet {
  get(name: string): Logger;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ConfigFacet {
  /**
   * Resolve an assistant feature flag by kebab-case key. Returns `true`
   * when the flag is enabled for this assistant (per registry default and
   * any user overrides).
   */
  isFeatureFlagEnabled(key: string): boolean;
  /**
   * Read a typed section from the assistant's resolved config. The `path`
   * is a dot-separated key into the config tree (e.g. `"services.meet"`).
   * Returns `undefined` when the section is not present. The daemon
   * redacts / validates the payload before it reaches the skill; skills
   * should still runtime-validate any security-critical fields.
   */
  getSection<T>(path: string): T | undefined;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export interface IdentityFacet {
  /**
   * Current display name for the assistant, if configured. Returns
   * `undefined` when no name has been set.
   */
  getAssistantName(): string | undefined;
}

// ---------------------------------------------------------------------------
// Platform
// ---------------------------------------------------------------------------

export interface PlatformFacet {
  /** Absolute path to the current workspace directory (`getWorkspaceDir()`). */
  workspaceDir(): string;
  /** Absolute path to the Vellum data root (`vellumRoot()`). */
  vellumRoot(): string;
  /** Current runtime mode (bare-metal vs Docker). */
  runtimeMode(): DaemonRuntimeMode;
}

// ---------------------------------------------------------------------------
// Providers
//
// All concrete provider handle types are owned by `assistant/` — the skill
// never introspects them, it just threads them back through `host.*`
// methods. Declaring them opaquely here lets the package stay free of any
// provider-SDK transitive dependencies.
// ---------------------------------------------------------------------------

/** Opaque LLM provider handle (narrowed by the daemon to the concrete provider union). */
export type Provider = unknown;

/** Opaque "user message" content envelope accepted by `providers.llm.complete` style APIs. */
export type UserMessage = unknown;

/** Opaque `tool_use` content block extracted from an LLM response. */
export type ToolUse = unknown;

export interface LlmProvidersFacet {
  /**
   * Resolve the provider configured for the given LLM call site, or `null`
   * when no provider is available (missing credentials, unsupported
   * call-site, misconfigured profile). Async because the daemon's resolver
   * reads the credential store asynchronously.
   */
  getConfigured(callSite: string): Promise<Provider | null>;
  /** Wrap plain text into the provider's user-message envelope shape. */
  userMessage(text: string): UserMessage;
  /** Pull the first `tool_use` block out of a completion response, if any. */
  extractToolUse(response: unknown): ToolUse | null;
  /**
   * Produce an `AbortSignal` that fires after `ms` milliseconds, alongside a
   * `cleanup()` callback that cancels the underlying timer. Callers pass
   * `signal` into the LLM request and must invoke `cleanup()` in a `finally`
   * block so the timer does not leak when the request finishes first.
   */
  createTimeout(ms: number): { signal: AbortSignal; cleanup: () => void };
}

/** Opaque STT spec (skill passes an instance obtained from config through). */
export type SttSpec = unknown;

/** Opaque streaming transcriber handle. */
export type StreamingTranscriber = unknown;

export interface SttProvidersFacet {
  listProviderIds(): string[];
  supportsBoundary(id: string): boolean;
  /**
   * Resolve a streaming transcriber for `spec`, or `null` when no configured
   * STT provider supports the requested boundary/diarization. Async because
   * the daemon's resolver reads credentials and pings the provider catalog.
   */
  resolveStreamingTranscriber(
    spec: SttSpec
  ): Promise<StreamingTranscriber | null>;
}

/** Opaque TTS provider handle. */
export type TtsProvider = unknown;

/** Opaque TTS runtime config. */
export type TtsConfig = unknown;

export interface TtsProvidersFacet {
  get(id: string): TtsProvider;
  resolveConfig(): TtsConfig;
}

export interface SecureKeysFacet {
  /** Retrieve a provider API key from the secure credential store, or `null` if absent. */
  getProviderKey(id: string): Promise<string | null>;
}

export interface ProvidersFacet {
  llm: LlmProvidersFacet;
  stt: SttProvidersFacet;
  tts: TtsProvidersFacet;
  secureKeys: SecureKeysFacet;
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

/**
 * Valid message roles for `memory.addMessage`. The messages store is
 * UI-facing (`ConversationMessage`), so only renderable turns are accepted —
 * agent-context `system` rows are not persisted via this facet.
 */
export type MessageRole = "user" | "assistant";

/**
 * Callable signature for `memory.addMessage`. Mirrors the daemon's
 * `addMessage()` (in `assistant/src/memory/conversation-crud.ts`) shape.
 * The return type is left as `unknown` because the daemon has additional
 * fields (message id, metadata echo) that skills should not depend on.
 */
export interface InsertMessageOptions {
  metadata?: Record<string, unknown>;
  skipIndexing?: boolean;
}

export type InsertMessageFn = (
  conversationId: string,
  role: MessageRole,
  content: string,
  options?: InsertMessageOptions
) => Promise<unknown>;

/** Opaque payload passed to `memory.wakeAgentForOpportunity`. */
export type WakeOpportunity = unknown;

export interface MemoryFacet {
  addMessage: InsertMessageFn;
  wakeAgentForOpportunity(req: WakeOpportunity): Promise<void>;
}

// ---------------------------------------------------------------------------
// History (read-only)
// ---------------------------------------------------------------------------

/**
 * A single conversation turn as seen through the read-only history facet.
 * Mirrors the daemon's `MessageRow` (in
 * `assistant/src/persistence/conversation-crud.ts`) but narrowed to the fields
 * a consolidation/retrieval plugin needs: only renderable `user`/`assistant`
 * turns reach the facet, so agent-context `system` scaffolding and rows flagged
 * `hidden` in metadata are never surfaced. `content` is the raw stored content
 * string (a JSON content-block array or plain text); `metadata` is the raw
 * stored metadata string, or `null`.
 */
export interface HistoryMessage {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  createdAt: number;
  metadata: string | null;
}

/**
 * A conversation header as seen through the read-only history facet. A narrow
 * projection of the daemon's `ConversationRow` — identity and provenance
 * fields a plugin needs to scope work, without the per-turn token/cost
 * accounting columns.
 */
export interface HistoryConversation {
  id: string;
  title: string | null;
  conversationType: string;
  source: string;
  createdAt: number;
  updatedAt: number;
  lastMessageAt: number | null;
  archivedAt: number | null;
}

/**
 * Composite pagination cursor: a `(createdAt, id)` pair. The `id` tie-breaker
 * makes the cursor stable across a page boundary that splits messages sharing
 * the same `createdAt` millisecond (imported / forked / same-ms rows) — a
 * timestamp-only cursor would skip the older same-ms rows. Pass the previous
 * page's {@link HistoryPage.nextCursor} back as {@link HistoryFacet}
 * `getMessages` `before`.
 */
export interface HistoryCursor {
  /** Resume strictly before this `createdAt` (with the `id` tie-breaker). */
  beforeTimestamp: number;
  /** Resume strictly before this message `id` among same-`createdAt` rows. */
  beforeId: string;
}

/** Result of a paginated history read, oldest→newest within the page. */
export interface HistoryPage {
  messages: HistoryMessage[];
  /** True when older messages exist before `messages[0]`. */
  hasMore: boolean;
  /**
   * Cursor for the next (older) page: pass back as {@link HistoryFacet}
   * `getMessages` `before`. `undefined` when there is nothing older.
   */
  nextCursor?: HistoryCursor;
}

/**
 * Options for {@link HistoryFacet.getMessages}. `before` is the composite
 * cursor — pass the previous page's {@link HistoryPage.nextCursor}. The legacy
 * `beforeTimestamp` (timestamp-only) is still accepted for simple callers;
 * when both are given `before` wins. With neither, the newest `limit` messages
 * are returned.
 */
export interface HistoryGetMessagesOptions {
  limit?: number;
  before?: HistoryCursor;
  /** @deprecated Pass {@link HistoryGetMessagesOptions.before} instead. */
  beforeTimestamp?: number;
}

/**
 * Read-only access to conversation and message history, applying the same
 * trust/visibility filtering the UI-facing history loads use (hidden rows and
 * non-`user`/`assistant` roles are dropped). A plugin reaches this for
 * post-turn consolidation/retrieval without importing `persistence/` or
 * `memory/`. Writes are NOT exposed here — they go through
 * {@link MemoryFacet.addMessage}.
 */
export interface HistoryFacet {
  /** The conversation header, or `null` if no such conversation exists. */
  getConversation(conversationId: string): Promise<HistoryConversation | null>;
  /**
   * The most recent `n` visible messages for a conversation, oldest→newest.
   */
  getRecentMessages(
    conversationId: string,
    n: number
  ): Promise<HistoryMessage[]>;
  /**
   * A page of visible messages, oldest→newest. With no cursor the newest
   * `limit` messages are returned; pass {@link HistoryPage.nextCursor} as
   * `before` to walk older pages.
   */
  getMessages(
    conversationId: string,
    options?: HistoryGetMessagesOptions
  ): Promise<HistoryPage>;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Subscription filter mirroring `AssistantEventFilter` from the daemon's hub. */
export interface Filter {
  /** When set, restrict delivery to this conversation. */
  conversationId?: string;
}

/** Callback invoked for each event that matches a subscriber's filter. */
export type AssistantEventCallback = (
  event: AssistantEvent
) => void | Promise<void>;

/** Opaque handle returned by `events.subscribe`. Calling `dispose()` unsubscribes. */
export interface Subscription {
  dispose(): void;
  readonly active: boolean;
}

export interface EventsFacet {
  publish(event: AssistantEvent): Promise<void>;
  subscribe(filter: Filter, cb: AssistantEventCallback): Subscription;
  buildEvent(message: ServerMessage, conversationId?: string): AssistantEvent;
}

// ---------------------------------------------------------------------------
// Registries
// ---------------------------------------------------------------------------

/** Skill-provided HTTP route registration (subset of `assistant/`'s full type). */
export interface SkillRoute {
  pattern: RegExp;
  methods: string[];
  handler: (req: Request, match: RegExpMatchArray) => Promise<Response>;
}

/**
 * Opaque handle returned from `registries.registerSkillRoute`. Callers must
 * retain it as a black box and pass it back to the daemon at teardown; it
 * has no observable fields.
 */
declare const skillRouteHandleBrand: unique symbol;
export interface SkillRouteHandle {
  readonly [skillRouteHandleBrand]: true;
}

export interface RegistriesFacet {
  /**
   * Register a provider that returns the skill's tool list. The provider
   * is invoked lazily by the daemon's tool registry (so feature-flag gates
   * are re-evaluated on every manifest build).
   */
  registerTools(provider: () => Tool[]): void;
  /** Register a skill-owned HTTP route. */
  registerSkillRoute(route: SkillRoute): SkillRouteHandle;
  /**
   * Register a shutdown hook. The daemon calls it during orderly shutdown;
   * the `reason` argument matches the daemon's own shutdown-reason string.
   */
  registerShutdownHook(
    name: string,
    hook: (reason: string) => Promise<void>
  ): void;
}

// ---------------------------------------------------------------------------
// Embeddings
//
// A thin wrapper over the host's configured embedding backend. The host
// resolves which backend serves the request (local / remote / managed) from
// the assistant's config; the plugin only sees vectors out. Provider-agnostic
// by design — no backend identity leaks across this surface.
// ---------------------------------------------------------------------------

export interface EmbedOptions {
  /** Abort the in-flight embed request when this signal fires. */
  signal?: AbortSignal;
}

export interface EmbeddingsFacet {
  /**
   * Embed a batch of texts into dense vectors. Returns one vector per input,
   * in input order. The host selects the active embedding backend from the
   * assistant's config; the vector dimensionality matches that backend's
   * configured size. Rejects when no embedding backend is available.
   */
  embed(texts: string[], opts?: EmbedOptions): Promise<number[][]>;
}

// ---------------------------------------------------------------------------
// Vector store
//
// A plugin-namespaced dense-vector collection. The host names the underlying
// collection by the plugin's id so two plugins using the same logical name
// (e.g. "pages") never collide. The plugin supplies its own point ids and an
// opaque metadata payload; the store round-trips both.
// ---------------------------------------------------------------------------

/** A single dense-vector point to upsert. */
export interface VectorPoint {
  /** Caller-stable id; re-upserting the same id overwrites the point. */
  id: string;
  /** Dense embedding for this point. */
  vector: number[];
  /** Opaque metadata round-tripped on search results. */
  payload?: Record<string, unknown>;
}

/** A search hit, ordered most-similar first. */
export interface VectorSearchResult {
  id: string;
  score: number;
  payload: Record<string, unknown>;
}

export interface VectorStoreFacet {
  /**
   * Obtain a handle to a plugin-owned collection. `name` is namespaced by the
   * plugin id under the hood, so the same `name` from two different plugins
   * refers to two distinct collections. `vectorSize` fixes the dimensionality
   * of the collection (must match the embeddings the plugin will write).
   */
  collection(
    name: string,
    options: { vectorSize: number }
  ): Promise<VectorCollection>;
}

export interface VectorCollection {
  /** Upsert one or more points (overwrites by id). */
  upsert(points: VectorPoint[]): Promise<void>;
  /** Nearest-neighbour search; returns up to `limit` hits, best first. */
  search(vector: number[], limit: number): Promise<VectorSearchResult[]>;
  /** Delete points by id. Unknown ids are ignored. */
  delete(ids: string[]): Promise<void>;
}

// ---------------------------------------------------------------------------
// Durable structured store
//
// A plugin-owned set of relational tables in the shared assistant database.
// Tables are namespaced by the plugin id under a fixed `plugin_<id>_` prefix,
// so two plugins declaring the same logical table name never collide and one
// plugin can never read or write another plugin's (or the core's) tables. The
// plugin declares its tables as append-only, checkpointed migrations the host
// applies idempotently; thereafter it runs typed `query`/`exec` against ITS OWN
// tables only — the facet rejects any statement that touches a table outside
// its prefix.
//
// Co-locating plugin tables in the shared DB (rather than a private SQLite
// file) lets a plugin join its rows against the read-only history facet's
// conversation/message views without crossing a process or file boundary.
// ---------------------------------------------------------------------------

/**
 * One append-only schema migration a plugin declares for its durable store.
 * The host runs each migration at most once per database, checkpointed under a
 * plugin-scoped namespace separate from the core migration ledger.
 *
 * `name` is the stable checkpoint key (must be non-empty and unique within the
 * plugin) — renaming it re-runs the migration, so treat the list as
 * append-only: add new entries, never reorder or rename existing ones. `up` is
 * the forward DDL; it MUST be idempotent (e.g. `CREATE TABLE IF NOT EXISTS`)
 * and may only create/alter tables under the plugin's `plugin_<id>_` prefix.
 */
export interface StoreMigration {
  /** Stable, non-empty checkpoint key, unique within the plugin. */
  name: string;
  /**
   * Forward DDL applied once per database. Receives a {@link StoreExec} scoped
   * to the plugin's tables; statements touching a table outside the plugin's
   * prefix are rejected. Must be idempotent.
   */
  up: (exec: StoreExec) => void;
}

/**
 * Execute a write/DDL statement (no rows returned) against the plugin's own
 * tables. Rejects any statement referencing a table outside the plugin's
 * `plugin_<id>_` namespace.
 */
export type StoreExec = (sql: string, params?: unknown[]) => void;

/**
 * The durable structured store handed to a plugin on {@link SkillHost.store}.
 * All access is scoped to the plugin's `plugin_<id>_`-prefixed tables; the
 * facet validates the target of every statement and throws on cross-namespace
 * access (another plugin's tables or the core schema).
 */
export interface StoreFacet {
  /**
   * Qualify a bare logical table name into the host-namespaced table name the
   * facet authorizes — e.g. `qualify("facts")` → `plugin_<id>_<hash>_facts`.
   *
   * The host owns the prefix scheme (it folds a digest of the plugin id into
   * the prefix so distinct plugins never collide), so a plugin MUST derive its
   * table names from this rather than hardcoding `plugin_...`: a hardcoded
   * prefix that does not match the host's scheme is rejected as a
   * cross-namespace reference on the first `query`/`exec`/`migrate`. Use the
   * returned name in every statement (DDL and DML) for that table.
   */
  qualify(name: string): string;
  /**
   * Apply the plugin's declared migrations idempotently, in order. Each is run
   * at most once per database, checkpointed under a plugin-scoped namespace
   * (separate from the core migration ledger). Safe to call on every boot —
   * already-applied migrations are skipped. The list is append-only: add new
   * migrations to the end, never reorder or rename existing ones.
   */
  migrate(migrations: StoreMigration[]): void;
  /**
   * Run a read query against the plugin's own tables and return the rows.
   * Rejects any statement referencing a table outside the plugin's prefix.
   */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
  /**
   * Run a write/DDL statement (INSERT/UPDATE/DELETE/CREATE/…) against the
   * plugin's own tables. Rejects cross-namespace access.
   */
  exec(sql: string, params?: unknown[]): void;
}

// ---------------------------------------------------------------------------
// Background jobs
//
// A plugin-namespaced view onto the assistant's durable background-job queue.
// Both the enqueued job `type` and the `type` a handler registers for are
// prefixed with `plugin:<id>:` by the host, so a plugin can only enqueue and
// handle ITS OWN job types — it can neither dispatch a core (e.g. memory) job
// nor claim one. Jobs run on the worker loop (on the daemon's poll cadence or
// the out-of-process worker), never synchronously at enqueue time and never
// unconditionally at boot.
// ---------------------------------------------------------------------------

/** A claimed background job handed to a plugin's handler. */
export interface PluginJob<T = Record<string, unknown>> {
  /**
   * The job type WITHOUT the `plugin:<id>:` prefix — the same string the plugin
   * passed to {@link JobsFacet.enqueue} / {@link JobsFacet.registerHandler}. The
   * host strips its namespace before dispatch so plugin code sees only its own
   * vocabulary.
   */
  type: string;
  /** The payload the job was enqueued with. */
  payload: T;
  /** Number of prior delivery attempts for this job. */
  attempts: number;
}

/** Optional controls for {@link JobsFacet.enqueue}. */
export interface EnqueueJobOptions {
  /**
   * Earliest epoch-ms the job may be claimed. Defaults to now (claimable on the
   * next worker poll). Use a future value to schedule deferred work.
   */
  runAfter?: number;
}

/**
 * A plugin-namespaced handle onto the background-job queue. The host prefixes
 * every `type` with `plugin:<id>:` so a plugin's jobs are isolated from core
 * jobs and from other plugins' jobs. A handler thrown error is retried with
 * backoff by the worker (it owns the retry policy); the handler must be
 * idempotent.
 */
export interface JobsFacet {
  /**
   * Enqueue a durable background job of `type` (namespaced to this plugin). The
   * job is persisted and claimed by the worker loop on a later poll — this call
   * does no work synchronously. Returns the enqueued job's id.
   */
  enqueue(
    type: string,
    payload: Record<string, unknown>,
    opts?: EnqueueJobOptions
  ): string;
  /**
   * Register a handler for this plugin's `type`. The worker dispatches each
   * claimed job of the namespaced type to `handler`. A later registration for
   * the same `type` replaces the earlier one.
   */
  registerHandler(
    type: string,
    handler: (job: PluginJob) => void | Promise<void>
  ): void;
}

// ---------------------------------------------------------------------------
// Speakers
// ---------------------------------------------------------------------------

/** Opaque speaker-identity tracker (concrete type is owned by `assistant/`). */
export type SpeakerIdentityTracker = unknown;

export interface SpeakersFacet {
  createTracker(): SpeakerIdentityTracker;
}

// ---------------------------------------------------------------------------
// Aggregate SkillHost
// ---------------------------------------------------------------------------

/**
 * Everything a skill needs from the daemon, grouped by concern. Provided
 * to the skill's `register(host)` entry point in place of the direct
 * `assistant/` imports skills used historically.
 *
 * Implementations:
 * - `DaemonSkillHost` (PR 7) — in-process bridge from each facet to the
 *   daemon's existing modules.
 * - `SkillHostClient` (PR 25) — IPC-backed implementation used once the
 *   skill runs out-of-process.
 */
export interface SkillHost {
  logger: LoggerFacet;
  config: ConfigFacet;
  identity: IdentityFacet;
  platform: PlatformFacet;
  providers: ProvidersFacet;
  memory: MemoryFacet;
  history: HistoryFacet;
  events: EventsFacet;
  registries: RegistriesFacet;
  speakers: SpeakersFacet;
  embeddings: EmbeddingsFacet;
  vectorStore: VectorStoreFacet;
  store: StoreFacet;
  jobs: JobsFacet;
}

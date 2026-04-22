/**
 * Plugin core types.
 *
 * This file is scaffolding only — it defines the shape of the plugin system
 * without wiring any behavior. Later PRs in the `agent-plugin-system` plan
 * refine per-pipeline argument/result types (currently `unknown`-based
 * placeholders) and add the pipeline runner, registry, and bootstrap.
 *
 * The assistant composes behavior around a small set of named pipelines
 * (`turn`, `llmCall`, `toolExecute`, ...). Each plugin may contribute one
 * {@link Middleware} per pipeline; the registry composes them in onion
 * order at runtime. Plugins may also contribute {@link Injector}s that emit
 * system-prompt-time content, as well as model-visible capabilities
 * (`tools`, `routes`, `skills`).
 *
 * Design doc: `.private/plans/agent-plugin-system.md`.
 */

import type { TrustContext } from "../daemon/conversation-runtime-assembly.js";
import { AssistantError, ErrorCode } from "../util/errors.js";

// ─── Manifest ────────────────────────────────────────────────────────────────

/**
 * Static metadata describing a plugin — declared at module load time and
 * validated by the registry (duplicate-name check, API-version compatibility).
 *
 * `provides` and `requires` are capability → semantic-version maps. The
 * registry checks each entry in `requires` against the assistant's exposed
 * capability table and refuses to register plugins that ask for a version the
 * assistant does not expose.
 */
export interface PluginManifest {
  /** Unique plugin identifier (kebab-case). Duplicate names fail registration. */
  name: string;
  /** Plugin version (semver). Informational — the registry compares
   *  capability versions via `requires`, not this field. */
  version: string;
  /** Capabilities this plugin exposes to other plugins (reserved for future composition). */
  provides?: Record<string, string>;
  /** Capabilities this plugin needs from the assistant runtime. */
  requires: Record<string, string>;
  /** Credential keys the plugin needs resolved before `init()` runs. */
  requiresCredential?: string[];
  /** Feature flag keys that must be enabled for this plugin to activate. */
  requiresFlag?: string[];
  /**
   * Zod-compatible validator (or any parser-like object) for the plugin's
   * config block under `plugins.<name>`. Typed as `unknown` here — concrete
   * validators land in M2/M3 PRs.
   */
  config?: unknown;
}

// ─── Init context ────────────────────────────────────────────────────────────

/**
 * Context passed to `Plugin.init()` during bootstrap. Carries resolved
 * config/credentials, a pino-compatible logger scoped to the plugin, a
 * per-plugin writable data directory, and the assistant's version metadata.
 */
export interface PluginInitContext {
  /** Parsed config for this plugin (may be `unknown` until the manifest validates). */
  config: unknown;
  /** Resolved credential values keyed by the entries of `manifest.requiresCredential`. */
  credentials: Record<string, string>;
  /**
   * Pino-compatible child logger bound to `{ plugin: <name> }`. Untyped here
   * to avoid pulling pino into the types module.
   */
  logger: unknown;
  /** Absolute path to `~/.vellum/plugins-data/<plugin>/` (created by bootstrap). */
  pluginStorageDir: string;
  /** Assistant semver for compatibility checks inside the plugin. */
  assistantVersion: string;
  /** Capability → version-list map (`ASSISTANT_API_VERSIONS`) for defensive runtime checks. */
  apiVersions: Record<string, string[]>;
}

// ─── Middleware ──────────────────────────────────────────────────────────────

/**
 * Generic onion-style middleware. Each middleware may observe/modify the
 * arguments, decide whether to call `next` (short-circuit) or return a
 * synthetic result, and observe/modify the downstream result. `ctx` is the
 * immutable per-turn {@link TurnContext}.
 */
export type Middleware<A, R> = (
  args: A,
  next: (args: A) => Promise<R>,
  ctx: TurnContext,
) => Promise<R>;

// ─── Pipeline names ──────────────────────────────────────────────────────────

/**
 * Exhaustive list of pipeline slot names. New pipelines must be added here
 * and in `DEFAULT_TIMEOUTS` (PR 12). The registry only understands these.
 */
export type PipelineName =
  | "turn"
  | "llmCall"
  | "toolExecute"
  | "memoryRetrieval"
  | "historyRepair"
  | "tokenEstimate"
  | "compaction"
  | "overflowReduce"
  | "persistence"
  | "titleGenerate"
  | "toolResultTruncate"
  | "emptyResponse"
  | "toolError"
  | "circuitBreaker";

// ─── Per-pipeline args / results (placeholder shapes) ────────────────────────
// Concrete field-level types land in M2/M3 PRs as each pipeline is wrapped.
// Until then we expose `unknown`-tagged aliases so downstream code can name
// the types without depending on unstable internal shapes.

export type TurnArgs = { readonly input: unknown };
export type TurnResult = { readonly output: unknown };

export type LLMCallArgs = { readonly input: unknown };
export type LLMCallResult = { readonly output: unknown };

export type ToolExecuteArgs = { readonly input: unknown };
export type ToolExecuteResult = { readonly output: unknown };

export type MemoryRetrievalArgs = { readonly input: unknown };
export type MemoryRetrievalResult = { readonly output: unknown };

export type HistoryRepairArgs = { readonly input: unknown };
export type HistoryRepairResult = { readonly output: unknown };

export type TokenEstimateArgs = { readonly input: unknown };
export type TokenEstimateResult = { readonly output: unknown };

export type CompactionArgs = { readonly input: unknown };
export type CompactionResult = { readonly output: unknown };

export type OverflowReduceArgs = { readonly input: unknown };
export type OverflowReduceResult = { readonly output: unknown };

/**
 * Pipeline arguments for `persistence` — a discriminated union over the
 * message-CRUD operations plugins may observe, redirect, or short-circuit:
 *
 * - `add`    — append a new message (`addMessage`). Mirrors
 *              `addMessage(conversationId, role, content, metadata?, opts?)`.
 *              When `syncToDisk` is set, the default plugin also runs
 *              {@link syncMessageToDisk} against the just-persisted row so
 *              the JSONL disk view stays consistent. The `createdAtMs` field
 *              carries the conversation's creation timestamp — needed to
 *              resolve the disk-view directory path.
 * - `update` — shallow-merge metadata into an existing message
 *              (`updateMessageMetadata`). Returns `void`.
 * - `delete` — remove a single message (`deleteMessageById`). Returns the
 *              {@link DeletedMemoryIds}-shaped segment/summary IDs the caller
 *              must clean up out-of-band.
 *
 * The discriminated `op` field lets plugin middleware narrow the union and
 * tailor behavior per-operation (e.g. "only observe deletes", "redirect
 * adds to a mock store").
 */
export type PersistAddArgs = {
  readonly op: "add";
  readonly conversationId: string;
  readonly role: string;
  readonly content: string;
  readonly metadata?: Record<string, unknown>;
  readonly addOptions?: { readonly skipIndexing?: boolean };
  /**
   * When `true`, the default plugin additionally invokes
   * {@link syncMessageToDisk} with the returned message's id. Requires
   * {@link createdAtMs} to resolve the conversation's disk-view directory.
   */
  readonly syncToDisk?: boolean;
  /** Conversation creation timestamp — only read when `syncToDisk` is true. */
  readonly createdAtMs?: number;
};

export type PersistUpdateArgs = {
  readonly op: "update";
  readonly messageId: string;
  readonly updates: Record<string, unknown>;
};

export type PersistDeleteArgs = {
  readonly op: "delete";
  readonly messageId: string;
};

export type PersistArgs =
  | PersistAddArgs
  | PersistUpdateArgs
  | PersistDeleteArgs;

/**
 * Result row returned by an `add` op — matches the shape produced by
 * {@link addMessage}. Kept structural (not imported from `memory/`) so the
 * plugin types module stays decoupled from the storage layer.
 */
export type PersistAddResult = {
  readonly op: "add";
  readonly message: {
    readonly id: string;
    readonly conversationId: string;
    readonly role: string;
    readonly content: string;
    readonly createdAt: number;
    readonly metadata?: string;
  };
};

export type PersistUpdateResult = { readonly op: "update" };

/** IDs of segments/summaries the caller must remove from Qdrant. */
export type PersistDeleteResult = {
  readonly op: "delete";
  readonly segmentIds: string[];
  readonly deletedSummaryIds: string[];
};

export type PersistResult =
  | PersistAddResult
  | PersistUpdateResult
  | PersistDeleteResult;

export type TitleGenerateArgs = { readonly input: unknown };
export type TitleGenerateResult = { readonly output: unknown };

export type ToolResultTruncateArgs = { readonly input: unknown };
export type ToolResultTruncateResult = { readonly output: unknown };

export type EmptyResponseArgs = { readonly input: unknown };
export type EmptyResponseResult = { readonly output: unknown };

export type ToolErrorArgs = { readonly input: unknown };
export type ToolErrorResult = { readonly output: unknown };

export type CircuitBreakerArgs = { readonly input: unknown };
export type CircuitBreakerResult = { readonly output: unknown };

/**
 * Mapping from {@link PipelineName} to the middleware signature the registry
 * expects for that slot. Used both to shape `Plugin.middleware` and to drive
 * `getMiddlewaresFor<P>()` type narrowing in PR 13.
 */
export interface PipelineMiddlewareMap {
  turn: Middleware<TurnArgs, TurnResult>;
  llmCall: Middleware<LLMCallArgs, LLMCallResult>;
  toolExecute: Middleware<ToolExecuteArgs, ToolExecuteResult>;
  memoryRetrieval: Middleware<MemoryRetrievalArgs, MemoryRetrievalResult>;
  historyRepair: Middleware<HistoryRepairArgs, HistoryRepairResult>;
  tokenEstimate: Middleware<TokenEstimateArgs, TokenEstimateResult>;
  compaction: Middleware<CompactionArgs, CompactionResult>;
  overflowReduce: Middleware<OverflowReduceArgs, OverflowReduceResult>;
  persistence: Middleware<PersistArgs, PersistResult>;
  titleGenerate: Middleware<TitleGenerateArgs, TitleGenerateResult>;
  toolResultTruncate: Middleware<
    ToolResultTruncateArgs,
    ToolResultTruncateResult
  >;
  emptyResponse: Middleware<EmptyResponseArgs, EmptyResponseResult>;
  toolError: Middleware<ToolErrorArgs, ToolErrorResult>;
  circuitBreaker: Middleware<CircuitBreakerArgs, CircuitBreakerResult>;
}

// ─── TurnContext ─────────────────────────────────────────────────────────────

/**
 * Per-turn execution context threaded through every middleware invocation.
 *
 * Combines turn-level identifiers (`requestId`, `conversationId`,
 * `turnIndex`), the optionally-bound `pluginName` (set by the pipeline
 * runner when invoking a specific plugin's middleware, for error
 * attribution), and the canonical {@link TrustContext} that carries trust
 * class and channel identity for the inbound actor.
 *
 * `TrustContext` is re-exposed here (rather than redefined) so the plugin
 * surface always stays in sync with the assistant's trust model.
 */
export interface TurnContext {
  /** Stable ID for the current request (one per inbound message). */
  requestId: string;
  /** Conversation ID the turn is scoped to. */
  conversationId: string;
  /** 0-based turn index within the conversation. */
  turnIndex: number;
  /**
   * When the pipeline runner is executing a specific plugin's middleware,
   * this is set to that plugin's name so downstream code (error wrapping,
   * telemetry) can attribute work accurately.
   */
  pluginName?: string;
  /** Trust classification and channel identity for the inbound actor. */
  trust: TrustContext;
}

// ─── Injectors ───────────────────────────────────────────────────────────────

/**
 * A structured fragment injected into the system prompt (or a comparable
 * assembly point). Concrete shape is intentionally loose at this stage; M2
 * PRs refine it into a tagged block with deterministic ordering semantics.
 */
export type InjectionBlock = {
  /** Stable block identifier (used for dedupe/ordering). */
  readonly id: string;
  /** Plain-text body to insert. */
  readonly text: string;
  /** Optional metadata the renderer may use. */
  readonly meta?: Readonly<Record<string, unknown>>;
};

/**
 * A named producer of {@link InjectionBlock}s.
 *
 * `order` sorts injectors ascending within each turn. Producers return
 * `null` to opt out for the current turn.
 */
export interface Injector {
  /** Stable name (distinct across all registered injectors). */
  name: string;
  /** Ascending sort key — lower runs first. */
  order: number;
  /** Produce a block, or `null` to contribute nothing on this turn. */
  produce(ctx: TurnContext): Promise<InjectionBlock | null>;
}

// ─── Model-visible capability slots (placeholder shapes) ─────────────────────
// Concrete shapes are defined by the tool/route/skill registries. Typing
// them as `unknown`-tagged aliases here keeps the Plugin interface decoupled
// until later PRs wire real registrations.

/** Tool registration contributed by a plugin. Concrete shape TBD. */
export type PluginToolRegistration = unknown;
/** HTTP route registration contributed by a plugin. Concrete shape TBD. */
export type PluginRouteRegistration = unknown;
/** Skill registration contributed by a plugin. Concrete shape TBD. */
export type PluginSkillRegistration = unknown;

// ─── Plugin ──────────────────────────────────────────────────────────────────

/**
 * A registered plugin. Every field besides `manifest` is optional — a plugin
 * may contribute any combination of middleware, injectors, and model-visible
 * capabilities. Lifecycle hooks (`init`, `onShutdown`) run sequentially
 * during daemon startup/shutdown.
 */
export interface Plugin {
  /** Static manifest validated by the registry. */
  manifest: PluginManifest;
  /** Optional async initializer. Runs once during bootstrap, before traffic. */
  init?(ctx: PluginInitContext): Promise<void>;
  /** Optional shutdown hook. Runs during daemon shutdown in reverse-registration order. */
  onShutdown?(): Promise<void>;
  /** Tool registrations visible to the model. */
  tools?: PluginToolRegistration[];
  /** HTTP route registrations served by the assistant. */
  routes?: PluginRouteRegistration[];
  /** Skill registrations loaded at startup. */
  skills?: PluginSkillRegistration[];
  /** Prompt-time injectors contributed by this plugin. */
  injectors?: Injector[];
  /**
   * Named middleware slots. At most one middleware per slot per plugin.
   * The registry composes multiple plugins' middleware for a slot in
   * registration order (outermost first).
   */
  middleware?: Partial<PipelineMiddlewareMap>;
}

// ─── Errors ──────────────────────────────────────────────────────────────────

/**
 * Thrown by the pipeline runner when a plugin's middleware exceeds the
 * pipeline's configured timeout. Carries the pipeline name, the offending
 * plugin (if known), and the elapsed-milliseconds budget that was breached.
 */
export class PluginTimeoutError extends AssistantError {
  constructor(
    public readonly pipeline: PipelineName,
    public readonly pluginName: string | undefined,
    public readonly elapsedMs: number,
    options?: { cause?: unknown },
  ) {
    super(
      `Plugin pipeline '${pipeline}' timed out after ${elapsedMs}ms${
        pluginName ? ` (offending plugin: ${pluginName})` : ""
      }`,
      ErrorCode.INTERNAL_ERROR,
      options,
    );
    this.name = "PluginTimeoutError";
  }
}

/**
 * Thrown by registry and bootstrap for plugin lifecycle errors — registration
 * validation failures, API-version mismatches, init throw-outs. Distinct from
 * {@link PluginTimeoutError} so callers can discriminate.
 */
export class PluginExecutionError extends AssistantError {
  constructor(
    message: string,
    public readonly pluginName: string | undefined,
    options?: { cause?: unknown },
  ) {
    super(message, ErrorCode.INTERNAL_ERROR, options);
    this.name = "PluginExecutionError";
  }
}

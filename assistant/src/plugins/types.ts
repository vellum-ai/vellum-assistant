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

import type { ContextWindowConfig } from "../config/schemas/inference.js";
import type { ContextWindowResult } from "../context/window-manager.js";
import type { ReducerState } from "../daemon/context-overflow-reducer.js";
import type {
  InjectionMode,
  TrustContext,
} from "../daemon/conversation-runtime-assembly.js";
import type { Message } from "../providers/types.js";
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

/**
 * Input to the `overflowReduce` pipeline. Captures everything the reducer
 * tier loop needs, including the message history, reducer configuration,
 * and side-effect callbacks that bridge the pipeline back to the orchestrator's
 * mutable per-turn state (context-window manager, activity emitter, runtime
 * injection reassembly, memory reinjection).
 *
 * The callbacks are supplied by the orchestrator because the reducer loop
 * needs to coordinate with state that lives on the `AgentLoopConversationContext`
 * (message mutation, compaction event emission, circuit breaker tracking,
 * injection block reassembly). Keeping them as explicit callbacks — rather
 * than pulling the whole context into the pipeline — preserves the rule that
 * `TurnContext` stays minimal and pipeline-agnostic.
 */
export interface OverflowReduceArgs {
  /** Bare persisted message history (mutable copy — the default middleware
   *  applies reducer results in-place via the `applyMessages` callback). */
  readonly messages: Message[];
  /** Current run-time message array with runtime injections applied. */
  readonly runMessages: Message[];
  /** System prompt used for post-step token estimation. */
  readonly systemPrompt: string;
  /** Provider name used for token estimation (calibration provider key). */
  readonly providerName: string;
  /** Context window config (drives compaction behavior). */
  readonly contextWindow: ContextWindowConfig;
  /** Token budget the reducer must get below (preflight budget). */
  readonly preflightBudget: number;
  /** Tool-token overhead included in every estimation call. */
  readonly toolTokenBudget?: number;
  /** Maximum reducer iterations before the loop exits unconditionally. */
  readonly maxAttempts: number;
  /** Abort signal threaded through compaction calls. */
  readonly abortSignal?: AbortSignal;
  /**
   * Compaction callback — the reducer never owns the ContextWindowManager
   * instance. The orchestrator supplies this closure so the default plugin
   * can delegate the forced-compaction tier without crossing the
   * pipeline/infra boundary on its own.
   */
  readonly compactFn: (
    messages: Message[],
    signal: AbortSignal | undefined,
    options: unknown,
  ) => Promise<ContextWindowResult>;
  /**
   * Invoked before each reducer iteration to emit the `context_compacting`
   * activity state. The orchestrator owns activity emission because the
   * signal is trust/channel aware.
   */
  readonly emitActivityState: () => void;
  /**
   * Invoked after each reducer step that produced a successful compaction.
   * Handles circuit-breaker tracking, event emission, and context mutation.
   * The pipeline passes back `didCompact` so the orchestrator can flip its
   * `reducerCompacted` / `shouldInjectWorkspace` flags and the next
   * re-injection uses the fresh messages.
   */
  readonly onCompactionResult: (result: ContextWindowResult) => void;
  /**
   * Invoked after each step to rebuild `runMessages` from the step's
   * reduced history with the requested injection mode. The orchestrator
   * owns this helper so the full per-turn injection options object doesn't
   * leak into the pipeline surface. The plugin passes the current reduced
   * messages array explicitly so the orchestrator doesn't need to read
   * mutable shared state. Returns the new `runMessages`.
   */
  readonly reinjectForMode: (
    messages: Message[],
    mode: InjectionMode,
    didCompact: boolean,
  ) => Promise<Message[]>;
  /**
   * Invoked after each step to post-estimate the rebuilt `runMessages`.
   * Pulled out so the orchestrator controls how estimation is performed
   * (and which fields feed it) without the pipeline reimplementing it.
   */
  readonly estimatePostInjection: (runMessages: Message[]) => number;
}

/** Output of the `overflowReduce` pipeline. */
export interface OverflowReduceResult {
  /** Final reduced `ctx.messages` value (mutated in place by the reducer). */
  readonly messages: Message[];
  /** Final `runMessages` with re-applied runtime injections. */
  readonly runMessages: Message[];
  /** Final injection mode (may be `"minimal"` if the downgrade tier fired). */
  readonly injectionMode: InjectionMode;
  /** Accumulated reducer state at exit. */
  readonly reducerState: ReducerState;
  /** True if any step successfully compacted history. */
  readonly reducerCompacted: boolean;
  /** How many iterations of the tier loop executed. */
  readonly attempts: number;
}

export type PersistenceArgs = { readonly input: unknown };
export type PersistenceResult = { readonly output: unknown };

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
  persistence: Middleware<PersistenceArgs, PersistenceResult>;
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

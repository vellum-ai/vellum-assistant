/**
 * Plugin core types.
 *
 * This file is scaffolding only — it defines the shape of the plugin system
 * without wiring any behavior. Later PRs in the `agent-plugin-system` plan
 * refine per-pipeline argument/result types (currently `unknown`-based
 * placeholders) and add the pipeline runner, registry, and bootstrap.
 *
 * The assistant composes behavior around a small set of named pipelines
 * (`compaction`, `overflowReduce`, ...). Each plugin may contribute one
 * {@link Middleware} per pipeline; the registry composes them in onion
 * order at runtime. Plugins may also contribute {@link Injector}s that emit
 * system-prompt-time content, as well as model-visible capabilities
 * (`tools`, `routes`, `skills`).
 *
 * Design doc: `.private/plans/agent-plugin-system.md`.
 */

import type { CompactionCircuitClosedEvent } from "../api/events/compaction-circuit-closed.js";
import type { CompactionCircuitOpenEvent } from "../api/events/compaction-circuit-open.js";
import type { ContextWindowConfig } from "../config/schemas/inference.js";
import type { LLMCallSite } from "../config/schemas/llm.js";
import type {
  ContextWindowManager,
  ContextWindowResult,
} from "../context/window-manager.js";
import type { ReducerState } from "../daemon/context-overflow-reducer.js";
import type {
  ActiveSurfaceContext,
  ChannelCapabilities,
  ChannelCommandContext,
  InjectionMode,
} from "../daemon/conversation-runtime-assembly.js";
import type { TrustContext } from "../daemon/trust-context.js";
import type { ConversationGraphMemory } from "../memory/graph/conversation-graph-memory.js";
import type { PluginHookFn } from "../plugin-api/types.js";
import type { Message } from "../providers/types.js";
import type { SkillRoute } from "../runtime/skill-route-registry.js";
import type { Tool } from "../tools/types.js";
import { AssistantError, ErrorCode } from "../util/errors.js";

// ─── Manifest ────────────────────────────────────────────────────────────────

/**
 * Static metadata describing a plugin — declared at module load time and
 * validated by the registry (duplicate-name check, API-version compatibility).
 *
 * `provides` and `requires` are capability → semantic-version maps. The
 * registry checks each entry in `requires` against the assistant's exposed
 * capability table and refuses to register plugins that ask for a version the
 * assistant does not expose. `provides` is currently declared-but-unused —
 * see the field docstring below.
 */
export interface PluginManifest {
  /** Unique plugin identifier (kebab-case). Duplicate names fail registration. */
  name: string;
  /**
   * Plugin version (semver). Informational. Host-compat negotiation lives
   * in the plugin's `package.json` `peerDependencies["@vellumai/plugin-api"]`
   * range — checked by the external-plugin loader against the assistant's
   * own version at load time.
   */
  version: string;
  /** Credential keys the plugin needs resolved before `init()` runs. */
  requiresCredential?: string[];
  /**
   * Assistant feature-flag keys that must all be enabled for this plugin to
   * activate. Checked by `bootstrapPlugins` via `isAssistantFeatureFlagEnabled`
   * — if any listed flag is disabled, the plugin is skipped entirely for the
   * boot (no `init()`, no tool/route/skill contributions, no shutdown hook).
   */
  requiresFlag?: string[];
  /**
   * Zod-compatible validator (or any parser-like object) for the plugin's
   * config block under `plugins.<name>`. Typed as `unknown` here — concrete
   * validators land in M2/M3 PRs.
   */
  config?: unknown;
}

// ─── Public plugin-API types ─────────────────────────────────────────────────
// Defined in `assistant/src/plugin-api/types.ts` and re-exported here so
// existing internal call sites keep working. Plugin authors import these from
// `@vellumai/plugin-api`.
export type {
  PluginHookFn,
  PluginInitContext,
  PluginShutdownContext,
} from "../plugin-api/types.js";

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
export type PipelineName = "compaction" | "overflowReduce" | "circuitBreaker";

// ─── Per-pipeline args / results (placeholder shapes) ────────────────────────
// Concrete field-level types land in M2/M3 PRs as each pipeline is wrapped.
// Until then we expose `unknown`-tagged aliases so downstream code can name
// the types without depending on unstable internal shapes.

/**
 * Full output of a single memory-graph retrieval — the object returned by
 * {@link ConversationGraphMemory.prepareMemory} (injected messages, query
 * vectors, metrics). The agent loop consumes these fields directly to drive
 * PKB hint search and runtime injection.
 */
export type GraphMemoryResult = Awaited<
  ReturnType<ConversationGraphMemory["prepareMemory"]>
>;

/**
 * Pipeline inputs for the `compaction` slot — the arguments the assistant
 * would otherwise have passed to {@link ContextWindowManager.maybeCompact}.
 *
 * Typed via `unknown`-forwarded aliases to keep this module free of runtime
 * imports from `context/window-manager.ts` (which would pull the full
 * compaction machinery into anything that merely imports plugin types).
 * The default compaction plugin re-casts back to the concrete types before
 * delegating to the manager.
 */
export type CompactionArgs = {
  /** The message history to consider for compaction. */
  readonly messages: unknown;
  /** Abort signal forwarded to the compaction summary call. */
  readonly signal?: AbortSignal;
  /** `ContextWindowCompactOptions` — options block forwarded verbatim. */
  readonly options?: unknown;
};
/**
 * Pipeline result for the `compaction` slot — the full
 * {@link import("../context/window-manager.js").ContextWindowResult}
 * object returned by `maybeCompact()`. Kept as `unknown` here for the
 * same decoupling reason as {@link CompactionArgs}; consumers in
 * `daemon/conversation-agent-loop.ts` cast back to the concrete shape.
 */
export type CompactionResult = unknown;

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
  readonly onCompactionResult: (
    result: ContextWindowResult,
    compactedBasis?: Message[],
  ) => void | Promise<void>;
  /**
   * Invoked after each step to rebuild `runMessages` from the step's
   * reduced history with the requested injection mode. The orchestrator
   * owns this helper so the full per-turn injection options object doesn't
   * leak into the pipeline surface. The plugin passes the current reduced
   * messages array explicitly so the orchestrator doesn't need to read
   * mutable shared state. Returns the new `runMessages`.
   *
   * Two distinct "did compact" signals are passed so the orchestrator can
   * apply the correct per-iteration vs sticky gating:
   * - `stepCompacted` — whether THIS iteration's reducer step produced a
   *   fresh compaction. Gates PKB / NOW re-injection: compaction strips the
   *   existing blocks, so only iterations that just compacted need the
   *   content re-threaded. Iterations that only truncated tool results or
   *   downgraded injections must NOT force a re-injection or the token
   *   count grows each round.
   * - `accumulatedCompacted` — whether ANY iteration in this pipeline
   *   invocation has compacted. Gates `slackChronologicalMessages`
   *   suppression: once compaction has run, the captured Slack transcript
   *   snapshot would overwrite the compacted history, so it must stay
   *   suppressed for every subsequent iteration even if that iteration
   *   didn't re-compact.
   */
  readonly reinjectForMode: (
    messages: Message[],
    mode: InjectionMode,
    stepCompacted: boolean,
    accumulatedCompacted: boolean,
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

/**
 * Arguments for the `circuitBreaker` pipeline.
 *
 * A single call pattern handles both querying and updating the breaker:
 * - `{ key }` — query-only. Returns the current `{ open, cooldownRemainingMs? }`.
 * - `{ key, outcome }` — update state, then return the post-update decision.
 *
 * `key` identifies the circuit bucket so independent circuits (e.g. per
 * conversation, per provider) can coexist. The default compaction plugin
 * uses `"compaction:<conversationId>"`.
 *
 * `state` is a pragmatic extension beyond the minimal `{ key, outcome? }`
 * shape: the `Conversation` owns `consecutiveCompactionFailures` and
 * `compactionCircuitOpenUntil` because dev-only playground routes read and
 * mutate those fields directly. The default plugin reads/updates the same
 * container so the pipeline stays a pure wrapper rather than forking state
 * ownership.
 *
 * `onEvent` is optional — when provided, the default plugin emits
 * `compaction_circuit_open` / `compaction_circuit_closed` transition events
 * through it. Its parameter is narrowed to {@link CompactionCircuitEvent} (the
 * only two messages this pipeline ever emits) rather than the full
 * `ServerMessage` union, so a caller whose outbound channel can carry just
 * these two events can satisfy it. Callers that only want to query without
 * emitting can omit it.
 */
export type CircuitBreakerArgs = {
  readonly key: string;
  readonly outcome?: "success" | "failure";
  readonly state: {
    readonly conversationId: string;
    consecutiveCompactionFailures: number;
    compactionCircuitOpenUntil: number | null;
  };
  readonly onEvent?: (msg: CompactionCircuitEvent) => void;
};

/**
 * The complete set of transition events the `circuitBreaker` pipeline emits:
 * `compaction_circuit_open` when the breaker trips and `compaction_circuit_closed`
 * on the open→closed transition. Both are a subset of `ServerMessage`, so any
 * existing `ServerMessage` sink remains assignable to a
 * `(msg: CompactionCircuitEvent) => void` parameter.
 */
export type CompactionCircuitEvent =
  | CompactionCircuitOpenEvent
  | CompactionCircuitClosedEvent;

/**
 * Result of a `circuitBreaker` pipeline invocation.
 *
 * - `open` — `true` when the breaker is currently tripped (auto paths must
 *   skip). `false` when closed (auto paths may proceed).
 * - `cooldownRemainingMs` — when `open` is `true`, the number of ms until
 *   the breaker auto-closes (for informational display). Omitted when the
 *   breaker is closed.
 */
export type CircuitBreakerResult = {
  readonly open: boolean;
  readonly cooldownRemainingMs?: number;
};

/**
 * Mapping from {@link PipelineName} to the middleware signature the registry
 * expects for that slot. Used both to shape `Plugin.middleware` and to drive
 * `getMiddlewaresFor<P>()` type narrowing in PR 13.
 */
export interface PipelineMiddlewareMap {
  compaction: Middleware<CompactionArgs, CompactionResult>;
  overflowReduce: Middleware<OverflowReduceArgs, OverflowReduceResult>;
  circuitBreaker: Middleware<CircuitBreakerArgs, CircuitBreakerResult>;
}

// ─── TurnContext ─────────────────────────────────────────────────────────────

/**
 * Per-turn injection inputs threaded to every {@link Injector}.
 *
 * These fields carry the text, gating state, and PKB-search parameters that
 * the orchestrator resolves once per turn and hands to the injector chain so
 * each default injector can derive its own {@link InjectionBlock} output.
 *
 * The orchestrator populates this bag inside
 * `buildPluginTurnContextWithInjectionInputs` (called from
 * `conversation-agent-loop.ts` right before `applyRuntimeInjections`). Call
 * sites that synthesize a {@link TurnContext} outside of the agent loop
 * (tests, overflow-reducer reinjection, etc.) may omit the bag entirely —
 * every field is optional and every default injector treats a missing input
 * as "no injection on this turn".
 */
export interface TurnInjectionInputs {
  /**
   * Controls which runtime injections are applied. `"full"` (default) runs
   * every gating branch; `"minimal"` skips high-token optional blocks
   * (workspace, PKB, NOW.md, subagent status) and only emits safety-critical
   * context (unified turn context, etc.). Drives per-injector gating.
   */
  readonly mode?: InjectionMode;
  /** Disk-pressure cleanup-mode context or null to skip the warning. */
  readonly diskPressureContext?: DiskPressureInjectionContext | null;
  /** Workspace top-level context text (`<workspace>...`) or null to skip. */
  readonly workspaceTopLevelContext?: string | null;
  /** Pre-built unified-turn-context text (`<turn_context>...`) or null to skip. */
  readonly unifiedTurnContext?: string | null;
  /**
   * Pre-rendered v2 static memory content (essentials/threads/recent/buffer
   * concatenated, header-wrapped) or null to skip. The agent loop only
   * passes this on full-mode turns; the injector wraps it in `<memory>` for
   * the user message.
   */
  readonly memoryV2Static?: string | null;
  /** NOW.md scratchpad content or null to skip. */
  readonly nowScratchpad?: string | null;
  /** Pre-built `<active_subagents>` block or null to skip. */
  readonly subagentStatusBlock?: string | null;
  /** Channel capabilities — drives slack gating. */
  readonly channelCapabilities?: ChannelCapabilities | null;
  /**
   * Pre-rendered Slack chronological transcript that overrides `runMessages`
   * for any Slack conversation (channels and DMs alike). Null/undefined means
   * the default `runMessages` array is used unchanged.
   */
  readonly slackChronologicalMessages?: Message[] | null;
  /**
   * Pre-rendered `<active_thread>` focus block to append to the final user
   * turn when the inbound lives inside a Slack thread. Null/undefined means
   * no focus block is appended.
   */
  readonly slackActiveThreadFocusBlock?: string | null;
  /**
   * Active dashboard-surface context (read from `<active_workspace>`). Kept
   * on the injection inputs bag (not its own injector) because it is
   * orchestrator-owned surface state, not a default-chain element.
   */
  readonly activeSurface?: ActiveSurfaceContext | null;
  /** Channel command context (e.g. Telegram /start) or null to skip. */
  readonly channelCommandContext?: ChannelCommandContext | null;
  /** Voice call-control prompt or null to skip. */
  readonly voiceCallControlPrompt?: string | null;
  /** Gateway-provided transport hints (e.g. Slack thread context). */
  readonly transportHints?: string[] | null;
  /**
   * When true, inject the `<non_interactive_context>` block so the model
   * knows no human is present to answer clarification questions.
   */
  readonly isNonInteractive?: boolean;
  /**
   * True when the active conversation's type is "background" or "scheduled"
   * (see `isBackgroundConversationType`). Read by the `background-turn`
   * injector to wrap the tail user message with a contextual reminder when
   * the turn is also non-interactive.
   */
  readonly isBackgroundConversation?: boolean;
  /**
   * Active documents open in this conversation — surfaced by the
   * `active-documents` injector so the assistant can target existing docs
   * with `document_update` instead of creating duplicates.
   */
  readonly activeDocuments?: ReadonlyArray<{
    surfaceId: string;
    title: string;
    wordCount: number;
    updatedAt: number;
  }> | null;
}

export interface DiskPressureInjectionContext {
  /** True when the current turn is allowed to run only for storage cleanup. */
  readonly cleanupModeActive: boolean;
}

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
  /**
   * Optional handle to the conversation's {@link ContextWindowManager}.
   *
   * Attached by the orchestrator when building the per-turn context for
   * pipeline invocations that need to defer to the real compaction machinery
   * (notably the default `compaction` plugin). Pipelines that never touch
   * compaction can ignore this field; the default compaction plugin throws
   * a {@link PluginExecutionError} if it is missing, which keeps the failure
   * attributed to the plugin rather than surfacing as a late NPE downstream.
   *
   * Declared as an optional typed field so plugin code can read it without a
   * lenient cast. The optional shape is load-bearing: pipeline runner tests,
   * synthesized handler contexts, and other non-compaction call sites still
   * construct valid `TurnContext` literals without attaching a manager.
   */
  contextWindowManager?: ContextWindowManager;
  /**
   * Per-turn injection inputs consumed by the default injector chain.
   *
   * Omitted for call sites that don't drive runtime injection (pipeline-runner
   * tests, synthesized handler contexts, some background jobs). Each default
   * injector treats missing/absent fields as "no injection on this turn", so
   * a context without `injectionInputs` produces an empty injection chain.
   */
  injectionInputs?: TurnInjectionInputs;
  /**
   * The {@link LLMCallSite} this turn's pipeline work belongs to —
   * `"mainAgent"` for the user-facing conversational reply, or the specific
   * background/utility site (`"compactionAgent"`, `"subagentSpawn"`,
   * `"memoryConsolidation"`, `"conversationTitle"`, …) when the agent loop is
   * driving non-main work that happens to share the same `conversationId`.
   *
   * Lets {@link Injector}s and pipeline middleware scope their behaviour to
   * the main reply and stay out of background turns, which `onEvent` presence
   * alone cannot distinguish (compaction and subagent loops also stream).
   * Omitted by call sites that don't tag a site (synthesized test contexts);
   * consumers should treat absence conservatively.
   */
  callSite?: LLMCallSite;
}

// ─── Injectors ───────────────────────────────────────────────────────────────

/**
 * Where an {@link InjectionBlock} should be grafted onto the per-turn
 * `runMessages` array.
 *
 * - `"prepend-user-tail"` — prepend the block as a `text` content block to
 *   the tail user message's `content` array. Used when the block should
 *   appear before any other user content on this turn (e.g. the unified
 *   turn context, workspace top-level context).
 * - `"append-user-tail"` — append the block as a `text` content block to
 *   the tail user message. Used for blocks that should sit *after* the
 *   user's typed text (e.g. subagent status, slack active-thread focus).
 * - `"after-memory-prefix"` — insert the block immediately after any leading
 *   memory-prefix blocks (`<memory_context>`, `<memory __injected>`) on the
 *   tail user message. Keeps memory/PKB/NOW in their canonical relative
 *   order regardless of how many after-memory-prefix blocks are spliced.
 * - `"replace-run-messages"` — replace the full `runMessages` array with the
 *   block's `messagesOverride`. Used by the Slack chronological-transcript
 *   injector (the transcript is a whole new message list rendered from the
 *   persisted rows, not a tail-block mutation).
 */
export type InjectionPlacement =
  | "prepend-user-tail"
  | "append-user-tail"
  | "after-memory-prefix"
  | "replace-run-messages";

/**
 * A structured fragment contributed by an {@link Injector}.
 *
 * Each block carries the rendered `text` plus a {@link InjectionPlacement}
 * that tells `applyRuntimeInjections` where to graft it onto the per-turn
 * message array. The placement vocabulary preserves the positional
 * semantics of the hardcoded `inject*` helpers the default injectors
 * replaced — prepends, appends, and splices relative to memory-prefix
 * blocks all remain expressible.
 *
 * `placement` defaults to `"append-user-tail"` when omitted so the existing
 * ordering-contract tests (PR 21) that produce `{ id, text }` blocks
 * continue to compose via `composeInjectorChain` into a single
 * blank-line-separated string.
 *
 * `messagesOverride` is only consulted for `"replace-run-messages"` — other
 * placements ignore it.
 */
export interface InjectionBlock {
  /** Stable block identifier (used for dedupe/ordering). */
  readonly id: string;
  /** Plain-text body to insert. */
  readonly text: string;
  /**
   * Position within the tail user message (or the full runMessages array,
   * for `"replace-run-messages"`). Defaults to `"append-user-tail"` when
   * omitted.
   */
  readonly placement?: InjectionPlacement;
  /**
   * Replacement `runMessages` value for `"replace-run-messages"` placements.
   * Required when `placement === "replace-run-messages"`; ignored otherwise.
   */
  readonly messagesOverride?: Message[];
  /** Optional metadata the renderer may use. */
  readonly meta?: Readonly<Record<string, unknown>>;
}

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
  /**
   * Produce a block, or `null` to contribute nothing on this turn.
   *
   * `runMessages` is the turn's working message array — the same array the
   * chain's blocks are spliced onto — passed explicitly so injectors that
   * need the current prompt contents (e.g. the PKB reminder, which scans for
   * already-loaded `file_read` paths) read it from a parameter rather than a
   * field on the shared {@link TurnContext}. Absent for text-only chain
   * consumers ({@link composeInjectorChain}) that drive injectors without a
   * message array.
   */
  produce(
    ctx: TurnContext,
    runMessages?: Message[],
  ): Promise<InjectionBlock | null>;
}

// ─── Model-visible capability slots ──────────────────────────────────────────
// Concrete shapes are defined by the tool/route/skill registries. Tool
// contributions (PR 31) use the canonical `Tool` interface; route
// contributions (PR 32) use the `SkillRoute` shape from the skill-route
// registry; skill contributions (PR 33) ship with the concrete
// `PluginSkillRegistration` shape below so plugins can declare
// catalog-discoverable skills today.

/**
 * HTTP route registration contributed by a plugin. Plugins express routes as
 * {@link SkillRoute} values — the same shape the skill-route registry
 * consumes — so `registerSkillRoute` can accept them directly. Bootstrap
 * wires the registrations after `init()` succeeds, retains the opaque
 * handle returned by each `registerSkillRoute` call, and uses those handles
 * (not the regex patterns themselves) to unregister the plugin's routes on
 * shutdown. Identity-keyed unregistration is what keeps sibling owners that
 * happen to register the same regex from evicting each other's routes.
 */
export type PluginRouteRegistration = SkillRoute;

/**
 * A skill contributed by a plugin.
 *
 * When a plugin declares {@link Plugin.skills}, the bootstrap registers each
 * entry into an in-memory side catalog that {@link loadSkillCatalog} merges
 * into its output. The entry is then discoverable by the model's `skill_load`
 * / `skill_execute` flow under `source: "plugin"` — the same code paths used
 * for filesystem-backed skills.
 *
 * The fields mirror the subset of `SkillSummary` / `SkillDefinition` that
 * makes sense for an in-memory contribution. Inline commands and reference
 * files are out of scope for plugin skills in this PR — add them later if a
 * real plugin needs them.
 */
export interface PluginSkillRegistration {
  /** Stable skill id (kebab-case). Must be unique across the catalog. */
  id: string;
  /**
   * Skill "name" as surfaced to the model. Matches the SKILL.md frontmatter
   * `name` field for filesystem skills.
   */
  name: string;
  /**
   * Human-readable display name shown in UI lists. Defaults to `name` when
   * omitted — matches the filesystem-skill default.
   */
  displayName?: string;
  /** One-line description shown by `skill_load` / UI. */
  description: string;
  /** Full skill body returned when `skill_load` fires for this skill. */
  body: string;
  /** Optional emoji shown beside the skill in UI surfaces. */
  emoji?: string;
  /** Optional assistant feature-flag key — when set and the flag is OFF, the skill is filtered out. */
  featureFlag?: string;
  /** Compact routing cues injected into `<available_skills>` to guide selection. */
  activationHints?: string[];
  /** Conditions under which this skill should NOT be loaded. */
  avoidWhen?: string[];
  /** IDs of child skills that this skill includes (metadata-only, not auto-activated). */
  includes?: string[];
}

// ─── Plugin ──────────────────────────────────────────────────────────────────

/**
 * Map of lifecycle hooks contributed by a plugin. Keys match file
 * basenames under `<plugin>/hooks/` — the external loader populates one
 * entry per `hooks/<name>.{ts,js}` it finds. The runtime invokes
 * known keys (`init`, `shutdown`) at the matching lifecycle event;
 * unknown keys are forward-compat scaffolding.
 *
 * See `assistant/src/daemon/external-plugins-bootstrap.ts` for the
 * full lifecycle, and {@link PluginHookFn} for the per-entry signature.
 */
// The map stores hooks for arbitrary keys with arbitrary context shapes.
// `any` (rather than `unknown`) is required so concrete plugin signatures
// like `(ctx: PluginInitContext) => Promise<void>` and `() => Promise<void>`
// both assign in/out of slot entries under strict-function-types contravariance.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PluginHooks = Record<string, PluginHookFn<any>>;

/**
 * A registered plugin. Every field besides `manifest` is optional — a plugin
 * may contribute any combination of middleware and model-visible
 * capabilities. Lifecycle hooks live under `hooks`.
 */
export interface Plugin {
  /** Static manifest validated by the registry. */
  manifest: PluginManifest;
  /** Lifecycle hooks (init, shutdown). See {@link PluginHooks}. */
  hooks?: PluginHooks;
  /**
   * Tool registrations visible to the model. External plugin authors
   * declare the nameless `ToolDefinition` file shape (from
   * `@vellumai/plugin-api`); the loader derives `name` from the
   * `tools/<name>.ts` basename and runs the definition through
   * `finalizeTool` to fill omitted required fields, producing the
   * `Tool` values stored here. Category / ownership metadata is
   * stamped by `registerPluginTools` at registration time.
   */
  tools?: Tool[];
  /** HTTP route registrations served by the assistant. */
  routes?: PluginRouteRegistration[];
  /** Skill registrations loaded at startup. */
  skills?: PluginSkillRegistration[];
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

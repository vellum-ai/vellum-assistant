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
import type { RepairResult } from "../daemon/history-repair.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import type { PkbContextConversation } from "../daemon/pkb-context-tracker.js";
import type { TrustContext } from "../daemon/trust-context.js";
import type { QdrantSparseVector } from "../memory/qdrant-client.js";
import type {
  ContentBlock,
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
  ToolDefinition,
} from "../providers/types.js";
import type { SkillRoute } from "../runtime/skill-route-registry.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../tools/types.js";
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
  /** Plugin version (semver). Informational — the registry compares
   *  capability versions via `requires`, not this field. */
  version: string;
  /**
   * Capabilities this plugin exposes to other plugins.
   *
   * **Reserved for future cross-plugin composition — not currently consumed
   * by any runtime code.** The field is declared so future cross-plugin work
   * can land without a manifest version bump, but today nothing reads it and
   * plugins must not depend on it for capability discovery. See
   * `assistant/docs/plugins.md` (Cross-plugin communication) for the
   * rationale.
   */
  provides?: Record<string, string>;
  /** Capabilities this plugin needs from the assistant runtime. */
  requires: Record<string, string>;
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
  /** Absolute path to `<workspaceDir>/plugins-data/<plugin>/` (created by bootstrap). */
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

/**
 * Pipeline arguments for `llmCall` — mirrors the inputs to
 * {@link Provider.sendMessage}. The terminal handler (the default plugin)
 * delegates straight to `args.provider.sendMessage(args.messages, args.tools,
 * args.systemPrompt, args.options)`; middleware may observe or rewrite any
 * field before that call, short-circuit with a synthetic {@link LLMCallResult},
 * or post-process the response on the way out.
 *
 * `provider` is passed in `args` (rather than resolved from the runtime) so
 * middleware can swap it deterministically per-call. `options` carries the
 * full `SendMessageOptions` bag — `config`, `onEvent`, and `signal` — so
 * middleware can substitute streaming handlers or cancellation signals
 * without reconstructing them.
 */
export type LLMCallArgs = {
  readonly provider: Provider;
  readonly messages: Message[];
  readonly tools?: ToolDefinition[];
  readonly systemPrompt?: string;
  readonly options?: SendMessageOptions;
};
export type LLMCallResult = ProviderResponse;

/**
 * Arguments passed to the `toolExecute` pipeline — mirrors the public
 * {@link ToolExecutor.execute} signature so middleware can observe (and
 * mutate) the tool name, input payload, and the full {@link ToolContext}
 * before the terminal runs the actual execution.
 */
export interface ToolExecuteArgs {
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly context: ToolContext;
}

/**
 * Result returned from the `toolExecute` pipeline — identical to
 * {@link ToolExecutionResult} so short-circuit middleware can supply a
 * synthetic result without invoking the terminal.
 */
export type ToolExecuteResult = ToolExecutionResult;

/**
 * A single retrieved memory artifact.
 *
 * The memory-graph retriever emits complex, tightly-coupled state (content
 * blocks, query vectors, metrics, events, etc.) that downstream code in the
 * agent loop consumes holistically. Representing each memory-graph output as
 * an opaque `MemoryBlock` lets plugins swap in completely different shapes
 * (custom retrievers, mocks for testing) without requiring the plugin surface
 * to re-declare the graph result schema here. Refined by consumers via
 * runtime narrowing — the default retriever attaches a structural marker so
 * the agent loop can safely unwrap its own output.
 */
export type MemoryBlock = unknown;

/**
 * Inputs to the memory-retrieval pipeline. The pipeline takes only
 * identifiers and the trust context — the actual data sources (PKB files,
 * NOW.md, memory graph) are side-effectful and read by the terminal.
 *
 * `signal` is the per-turn abort signal forwarded to the memory graph's
 * `prepareMemory` call. Carrying it on `args` (rather than on the
 * `DefaultMemoryRetrievalDeps` extra-state bundle) is load-bearing: the
 * pipeline runner's `linkAbortSignal` swaps any `AbortSignal`-typed
 * property on top-level args for an internal linked signal, so a plugin
 * timeout (or external cancel) actually reaches `prepareMemory` and cancels
 * the underlying retrieval instead of letting it run to completion after
 * the pipeline has already errored.
 */
export interface MemoryArgs {
  readonly conversationId: string;
  readonly trustContext: TrustContext | undefined;
  readonly turnIndex: number;
  readonly signal: AbortSignal;
}

/**
 * Outputs of the memory-retrieval pipeline.
 *
 * - `pkbContent` / `nowContent`: trimmed file contents ready for injection,
 *   or `null` when the file is missing/empty.
 * - `memoryGraphBlocks`: zero or one memory-graph retrievals (the default
 *   retriever yields exactly one when the actor is trusted and the graph
 *   produced output, zero otherwise). Multi-entry arrays are reserved for
 *   future multi-source retrievers; the current agent loop consumes only
 *   the first entry.
 */
export interface MemoryResult {
  readonly pkbContent: string | null;
  readonly nowContent: string | null;
  readonly memoryGraphBlocks: ReadonlyArray<MemoryBlock>;
}

/**
 * Arguments for the `historyRepair` pipeline. `history` is the pre-repair
 * message list scheduled for the next provider call; `provider` is the
 * downstream provider key (`ctx.provider.name`) so plugins that want to
 * special-case repair per provider can discriminate without looking up the
 * ambient provider from `TurnContext`.
 *
 * The pipeline currently wraps only the standard pre-run repair pass
 * (`repairHistory`). The orchestrator's one-shot deep-repair fallback
 * (`deepRepairHistory`), invoked only after a provider ordering error,
 * remains a direct call. Adding a `mode` discriminator here would be
 * premature — deep-repair has no known plugin-level consumer yet.
 */
export type HistoryRepairArgs = {
  readonly history: Message[];
  readonly provider: string;
};

/**
 * Result of the `historyRepair` pipeline. Carries both the repaired message
 * list and the `RepairStats` record the orchestrator logs when any repair
 * happened — the default plugin forwards the shape unchanged from
 * {@link repairHistory}.
 */
export type HistoryRepairResult = RepairResult;

/**
 * Inputs to the `tokenEstimate` pipeline. The default middleware delegates
 * these straight to {@link estimatePromptTokensRaw}; custom plugins may
 * substitute an alternate estimator (e.g. provider-native tokenization) by
 * short-circuiting the pipeline with their own {@link EstimateResult}.
 *
 * Fields:
 * - `history` — current message list to estimate over.
 * - `systemPrompt` — system prompt string, or `undefined` when absent.
 * - `tools` — tool definitions visible on this turn. The default plugin
 *   sums their token budget via `estimateToolsTokens(tools)` and hands the
 *   result to the raw estimator via `toolTokenBudget`. Plugins that want to
 *   ignore tool cost can skip that term.
 * - `providerName` — canonical calibration provider key (the value returned
 *   by `getCalibrationProviderKey(provider)`). Drives provider-specific
 *   heuristics inside the raw estimator (e.g. Anthropic image sizing).
 */
export type EstimateArgs = {
  readonly history: Message[];
  readonly systemPrompt: string | undefined;
  readonly tools: ToolDefinition[];
  readonly providerName: string | undefined;
};

/** Result of the `tokenEstimate` pipeline — total estimated prompt tokens. */
export type EstimateResult = number;

/** Alias retained for symmetry with the rest of the pipeline-name family. */
export type TokenEstimateArgs = EstimateArgs;
/** Alias retained for symmetry with the rest of the pipeline-name family. */
export type TokenEstimateResult = EstimateResult;

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

/**
 * Arguments for the `titleGenerate` pipeline. Mirrors the parameters of
 * `queueGenerateConversationTitle` in `memory/conversation-title-service.ts`
 * so the default plugin can delegate verbatim.
 *
 * `provider` is optional because the underlying service falls back to
 * `getConfiguredProvider("conversationTitle")` when absent. `userMessage`
 * carries the first turn's text — the service uses it as LLM context and
 * also to derive a deterministic fallback title if the call fails.
 *
 * `onTitleUpdated` is a fire-and-forget callback the pipeline invokes when
 * the title is finally persisted. The default implementation is
 * fire-and-forget overall, so the pipeline result (`TitleResult`) carries no
 * payload — callers that need the title must use the callback.
 */
export type TitleArgs = {
  readonly conversationId: string;
  readonly provider?: Provider;
  readonly userMessage: string;
  readonly onTitleUpdated?: (title: string) => void;
};
/**
 * Result of the `titleGenerate` pipeline. The default implementation is
 * fire-and-forget (it schedules background work and returns immediately),
 * so there is nothing meaningful to return. Defined as an empty object so
 * custom plugins can opt into richer payloads later.
 */
export type TitleResult = Readonly<Record<string, never>>;

/**
 * @deprecated Alias kept for the M1 scaffolding era. Prefer {@link TitleArgs}.
 */
export type TitleGenerateArgs = TitleArgs;
/**
 * @deprecated Alias kept for the M1 scaffolding era. Prefer {@link TitleResult}.
 */
export type TitleGenerateResult = TitleResult;

/**
 * Input to the `toolResultTruncate` pipeline: the raw tool-result text and
 * the character budget the caller computed from the context-window share
 * (see `calculateMaxToolResultChars` in `context/tool-result-truncation.ts`).
 */
export type ToolResultTruncateArgs = {
  readonly content: string;
  readonly maxChars: number;
};

/**
 * Output of the `toolResultTruncate` pipeline: the (possibly truncated)
 * content and a boolean flag indicating whether the pipeline actually
 * shortened the input. Callers use `truncated` for telemetry / warnings.
 */
export type ToolResultTruncateResult = {
  readonly content: string;
  readonly truncated: boolean;
};

/**
 * Snapshot of the just-completed assistant turn plus retry/context counters
 * the `emptyResponse` pipeline needs to decide whether to nudge, accept, or
 * surface an error.
 *
 * `emptyResponseRetries` is the *current* retry counter — the pipeline may
 * compare it to `maxEmptyResponseRetries` to implement a retry cap. The loop
 * increments the counter only after a `"nudge"` decision; the pipeline is
 * stateless across turns.
 *
 * `priorAssistantHadVisibleText` signals that an earlier turn in the current
 * `run()` invocation already delivered user-visible text. When true, an
 * empty follow-up is the model correctly ending its turn and nudging would
 * mislead it into resending text the user already saw.
 */
export interface EmptyResponseArgs {
  /** Content blocks produced by the assistant on this turn. */
  readonly responseContent: ReadonlyArray<ContentBlock>;
  /**
   * Number of `tool_use` blocks in `responseContent`. Mirrors the loop's own
   * count so middleware doesn't have to recompute it. When > 0 the turn is
   * not empty — the model issued tool calls.
   */
  readonly toolUseBlocksLength: number;
  /** 0-based index of the tool-use turn being evaluated. */
  readonly toolUseTurns: number;
  /** How many empty-response nudges the loop has already issued this run. */
  readonly emptyResponseRetries: number;
  /** Upper bound for `emptyResponseRetries`. The default is 1. */
  readonly maxEmptyResponseRetries: number;
  /**
   * Whether ANY prior assistant turn in the current `run()` call carried
   * visible text. See `agent/loop.ts` for why the whole-run scan matters.
   */
  readonly priorAssistantHadVisibleText: boolean;
}

/**
 * Decision produced by the `emptyResponse` pipeline.
 *
 * - `"nudge"`  — loop appends `nudgeText` as a `user` message and retries.
 *                `nudgeText` MUST be present; it is what the model will see.
 * - `"accept"` — loop treats the turn as complete (pushes the assistant
 *                message to history and exits the tool-use chain normally).
 * - `"error"`  — loop surfaces a clear error. Reserved for middleware that
 *                wants to escalate an empty response rather than absorb it.
 */
export interface EmptyResponseDecision {
  readonly action: "nudge" | "accept" | "error";
  /** Nudge text the loop will push to history. Required when `action === "nudge"`. */
  readonly nudgeText?: string;
}

/** Alias so the {@link PipelineMiddlewareMap} entry names its own result shape. */
export type EmptyResponseResult = EmptyResponseDecision;

/**
 * Arguments to the `toolError` pipeline — invoked by the agent loop once per
 * turn that produced tool results, BEFORE the turn's tool-result user message
 * is pushed into history.
 *
 * `hasToolError` is true when at least one tool in the current turn returned
 * `isError: true`. `consecutiveErrorTurns` is the running count of
 * back-to-back error turns (reset to 0 on a clean turn, incremented on each
 * error turn). `maxConsecutiveErrorNudges` is the default cap the agent loop
 * currently applies; plugins receive it so they can match the default
 * threshold exactly or compute a relative offset.
 */
export type ToolErrorArgs = {
  readonly hasToolError: boolean;
  readonly consecutiveErrorTurns: number;
  readonly maxConsecutiveErrorNudges: number;
};

/**
 * Decision returned by the `toolError` pipeline. When `action` is `"nudge"`,
 * the agent loop appends a text block with `nudgeText` to the turn's tool
 * results so the next LLM turn sees the nudge. When `action` is `"skip"`, no
 * nudge is injected and the tool results pass through unchanged.
 */
export type ToolErrorDecision =
  | { readonly action: "nudge"; readonly nudgeText: string }
  | { readonly action: "skip" };

/** Alias kept so `PipelineMiddlewareMap.toolError` reads result-shaped. */
export type ToolErrorResult = ToolErrorDecision;

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
 * through it. Callers that just want to query without emitting (or without
 * a `ServerMessage` sink handy) can omit it.
 */
export type CircuitBreakerArgs = {
  readonly key: string;
  readonly outcome?: "success" | "failure";
  readonly state: {
    readonly conversationId: string;
    consecutiveCompactionFailures: number;
    compactionCircuitOpenUntil: number | null;
  };
  readonly onEvent?: (msg: ServerMessage) => void;
};

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
  turn: Middleware<TurnArgs, TurnResult>;
  llmCall: Middleware<LLMCallArgs, LLMCallResult>;
  toolExecute: Middleware<ToolExecuteArgs, ToolExecuteResult>;
  memoryRetrieval: Middleware<MemoryArgs, MemoryResult>;
  historyRepair: Middleware<HistoryRepairArgs, HistoryRepairResult>;
  tokenEstimate: Middleware<TokenEstimateArgs, TokenEstimateResult>;
  compaction: Middleware<CompactionArgs, CompactionResult>;
  overflowReduce: Middleware<OverflowReduceArgs, OverflowReduceResult>;
  persistence: Middleware<PersistArgs, PersistResult>;
  titleGenerate: Middleware<TitleArgs, TitleResult>;
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
  /** PKB auto-injected content (`<knowledge_base>...`) or null to skip. */
  readonly pkbContext?: string | null;
  /**
   * Whether PKB is active for this turn — drives the `<system_reminder>` /
   * hybrid-search relevance-hint branch.
   */
  readonly pkbActive?: boolean;
  /** Dense query vector surfaced from the graph memory retriever for PKB hints. */
  readonly pkbQueryVector?: number[];
  /** Optional sparse vector accompanying `pkbQueryVector`. */
  readonly pkbSparseVector?: QdrantSparseVector;
  /** Memory scope id used to filter PKB search results. */
  readonly pkbScopeId?: string;
  /**
   * Live conversation (or a minimal shape containing `messages`) used to
   * compute which PKB paths are already "in context" and therefore suppressed
   * from hint suggestions.
   */
  readonly pkbConversation?: PkbContextConversation;
  /** Auto-injected PKB filenames resolved relative to `pkbRoot`. */
  readonly pkbAutoInjectList?: string[];
  /** Absolute path to the PKB directory (e.g. `<workspace>/pkb`). */
  readonly pkbRoot?: string;
  /**
   * Working directory against which relative `file_read` paths resolve.
   * Falls back to `pkbRoot` when omitted.
   */
  readonly pkbWorkingDir?: string;
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
  /** Produce a block, or `null` to contribute nothing on this turn. */
  produce(ctx: TurnContext): Promise<InjectionBlock | null>;
}

// ─── Model-visible capability slots ──────────────────────────────────────────
// Concrete shapes are defined by the tool/route/skill registries. Tool
// contributions (PR 31) use the canonical `Tool` interface; route
// contributions (PR 32) use the `SkillRoute` shape from the skill-route
// registry; skill contributions (PR 33) ship with the concrete
// `PluginSkillRegistration` shape below so plugins can declare
// catalog-discoverable skills today.

/**
 * Tool registration contributed by a plugin. Uses the canonical {@link Tool}
 * interface from the tool registry — the bootstrap stamps `origin: "plugin"`
 * and `ownerPluginId: <plugin.name>` before handing the batch to
 * `registerPluginTools`, which keeps plugin ref-counts and conflict detection
 * in a namespace disjoint from real skills. Plugin authors supply the
 * functional fields (`name`, `description`, `getDefinition`, `execute`, etc.)
 * and leave the ownership metadata to the bootstrap to set authoritatively.
 */
export type PluginToolRegistration = Tool;
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

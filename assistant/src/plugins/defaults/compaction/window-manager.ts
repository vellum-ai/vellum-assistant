/**
 * Context window manager — the surface the rest of the daemon talks to
 * when it needs to know whether and how to compact a conversation.
 *
 * The actual compaction work is delegated to {@link runAssistantDrivenCompaction}
 * in `./compactor.js`, which hands the model the full conversation plus a
 * user-role instruction message and lets the assistant write its own
 * summary and choose its own cut point.
 *
 * This module retains a small set of legacy exports — `CONTEXT_SUMMARY_MARKER`,
 * `createContextSummaryMessage`, `getSummaryFromContextMessage` — because
 * conversation reload, fork inheritance, and Slack chronological-context
 * assembly all detect a previously-produced summary via the marker. The
 * marker is wrapped around the assistant-role memory message we emit on
 * successful compaction so those code paths keep working unchanged.
 */
import type {
  ContentBlock,
  LLMCallSite,
  Message,
  Provider,
} from "@vellumai/plugin-api";

import { getConfig } from "../../../config/loader.js";
import type { CompactionConfig } from "../../../config/schemas/compaction.js";
import type { ContextWindowConfig } from "../../../config/types.js";
import {
  type CompactionRunArgs,
  type CompactionRunResult,
  isSyntheticCompactionMessage,
  runAssistantDrivenCompaction,
  runEmergencyCompaction,
} from "../../../context/compactor.js";
import {
  estimatePromptTokens,
  estimateToolsTokens,
} from "../../../context/token-estimator.js";
import { findConversationOrSubagent } from "../../../daemon/conversation-registry.js";
import type { InjectionMode } from "../../../daemon/conversation-runtime-assembly.js";
import type { ToolDefinition } from "../../../providers/types.js";
import type { TrustClass } from "../../../runtime/actor-trust-resolver.js";
import { getLogger } from "../../../util/logger.js";
import {
  createInitialReducerState,
  reduceContextOverflow,
  type ReducerConfig,
  type ReducerState,
  type ReducerStepResult,
} from "./context-overflow-reducer.js";
import { computeCorrectedOverflowTarget } from "./corrected-target.js";
import { resolveOverflowAction } from "./overflow-policy.js";

const log = getLogger("context-window");

export const CONTEXT_SUMMARY_MARKER = "<context_summary>";
const CONTEXT_SUMMARY_CLOSE = "</context_summary>";
const INTERNAL_CONTEXT_SUMMARY_MESSAGES = new WeakSet<Message>();

// ---------------------------------------------------------------------------
// Public types — preserved for downstream consumers (agent loop, conversation,
// default compaction plugin, applyCompactionResult,
// routes/playground/force-compact).
// ---------------------------------------------------------------------------

export interface ContextWindowResult {
  messages: Message[];
  compacted: boolean;
  previousEstimatedInputTokens: number;
  estimatedInputTokens: number;
  maxInputTokens: number;
  thresholdTokens: number;
  compactedMessages: number;
  compactedPersistedMessages: number;
  /**
   * Number of recent ("tail") messages preserved verbatim alongside the
   * summary. Omitted on no-op / skipped results — defaults to 0 at render.
   */
  preservedTailMessages?: number;
  summaryCalls: number;
  summaryInputTokens: number;
  summaryOutputTokens: number;
  summaryModel: string;
  summaryCallSite?: LLMCallSite;
  summaryOverrideProfile?: string | null;
  summaryCacheCreationInputTokens?: number;
  summaryCacheReadInputTokens?: number;
  summaryRawResponses?: unknown[];
  summaryText: string;
  reason?: string;
  summaryFailed?: boolean;
  /**
   * Set to `true` when {@link ContextWindowManager.maybeCompact} ran the
   * compactor up to `overflowRecovery.maxAttempts` times and still could
   * not reduce the estimated input tokens below the auto-threshold (or a
   * single attempt produced no token reduction at all). Callers that
   * orchestrate mid-loop compaction use this as the "give up, escalate"
   * signal — there's no point retrying the compactor again; reducers
   * (truncation / media stubbing) need to step in.
   *
   * Omitted (treated as `false`) on no-op early returns and on successful
   * compactions that did clear the threshold.
   */
  exhausted?: boolean;
  /**
   * Runtime-injection volume the overflow reduction ladder settled on for the
   * next provider call. The injection-downgrade rung lowers this to
   * `"minimal"`; every other rung leaves it `"full"`. The agent loop forwards
   * it to the post-compaction re-injection so the reduced prompt keeps the
   * volume the ladder chose. Omitted on the ordinary (non-overflow) compaction
   * path, where re-injection always runs at `"full"`.
   */
  injectionMode?: InjectionMode;
  /**
   * Set when the overflow reduction ladder applied its terminal
   * auto-compress-latest-turn rung. The agent loop reads it to classify the
   * terminal exit when recovery is exhausted: a still-too-large turn after
   * auto-compress ran is a `budget_yield_unrecovered`, without it a
   * `context_too_large`. Omitted on the ordinary compaction path.
   */
  autoCompressApplied?: boolean;
  /**
   * Propagated from the compactor: the deterministic forward-cut hit the tail
   * floor while still over the low-watermark budget. {@link _maybeCompact} reads
   * it to stop retrying — a second pass lands on the same floor and frees
   * nothing. See {@link CompactionRunResult.tailFloorReached}.
   */
  tailFloorReached?: boolean;
}

export interface ShouldCompactResult {
  needed: boolean;
  estimatedTokens: number;
}

export interface ContextWindowCompactOptions {
  /** Skip the auto-threshold check (used for /compact and recovery). */
  force?: boolean;
  /**
   * Per-conversation inference-profile override forwarded to the compaction
   * LLM call.
   */
  overrideProfile?: string | null;
  /**
   * Pre-computed token estimate from a prior {@link shouldCompact} call.
   * Avoids a redundant tokenization pass when the caller already has one.
   */
  precomputedEstimate?: number;
  /**
   * Legacy field retained for backwards compatibility with existing
   * callers. The new assistant-driven compactor does not consume it —
   * the model decides where to cut and what to keep — but accepting it
   * here lets callers keep their existing call sites unchanged.
   */
  minKeepRecentUserTurns?: number;
  /**
   * Trust class of the actor whose turn triggered compaction. Forwarded to
   * the compactor so the image manifest excludes guardian-only attachments
   * for untrusted actors.
   */
  actorTrustClass?: TrustClass;
  /**
   * Summarize everything before this in-memory history index ("summarize up
   * to here"). Single-attempt: bypasses the auto-threshold gate, the retry
   * ladder, and the token-budget forward-cut — the boundary is the user's
   * choice, not a budget outcome. Forwarded to the compactor's
   * `fixedTailStartIndex` (see {@link CompactionRunArgs.fixedTailStartIndex}
   * for range validation).
   */
  fixedTailStartIndex?: number;
}

export interface EmergencyCompactOptions {
  /**
   * The provider-reported estimate at the overflow that triggered recovery.
   * Sizing the emergency summary needs the actual rejected token count, not
   * the manager's pre-send estimate (which under-counted, hence the
   * rejection).
   */
  previousEstimatedInputTokens: number;
  /**
   * Per-conversation inference-profile override forwarded to the summary
   * call.
   */
  overrideProfile?: string | null;
}

/**
 * Turn-specific inputs for {@link ContextWindowManager.reduceOverflowOneRung}.
 * The manager owns everything the reduction ladder derives from its own state
 * (provider, system prompt, token budgets, conversation id, config, and the
 * running reducer state); the caller supplies only what is specific to the
 * overflow that triggered recovery.
 */
export interface OverflowRecoveryRungOptions {
  /**
   * Provider-reported token count from the overflow rejection, or `null` when
   * it could not be parsed. Lowers the compaction target in proportion to the
   * estimator's under-count so the reduced history lands under the provider's
   * true ceiling rather than the under-counted estimate.
   */
  actualTokens: number | null;
  /**
   * Whether the terminal auto-compress-latest-turn rung is permitted. The
   * caller resolves this from the overflow policy; the manager never makes the
   * policy call itself.
   */
  allowAutoCompressLatestTurn: boolean;
  /** Per-conversation inference-profile override for the summary call. */
  overrideProfile?: string | null;
  /** Trust class of the actor whose turn triggered overflow recovery. */
  actorTrustClass?: TrustClass;
}

export interface OverflowRecoveryOptions {
  /**
   * Provider-reported token count from the overflow rejection, or `null` when
   * it could not be parsed. Forwarded to the reduction ladder to correct the
   * compaction target against the estimator's under-count.
   */
  actualTokens: number | null;
  /**
   * Whether a human is present this turn. The manager resolves the
   * auto-compress-latest-turn permission from the overflow policy using this
   * flag, so callers signal interactivity rather than the policy verdict.
   */
  isInteractive: boolean;
  /** Per-conversation inference-profile override for the summary call. */
  overrideProfile?: string | null;
  /** Trust class of the actor whose turn triggered overflow recovery. */
  actorTrustClass?: TrustClass;
}

export interface ContextWindowManagerOptions {
  provider: Provider;
  config: ContextWindowConfig;
  /** Pre-computed tool token budget to include in all estimations. */
  toolTokenBudget?: number;
  /** Conversation ID — required for image-manifest and timestamp lookups. */
  conversationId?: string;
  /**
   * Optional tools resolver. The compactor passes tools to the provider on
   * the compaction call so the cached prefix (system prompt + tools +
   * conversation messages) matches the agent's main-turn cache key.
   */
  resolveTools?: () => ToolDefinition[] | undefined;
}

// ---------------------------------------------------------------------------
// Summary-message helpers (used by lifecycle rehydrate + fork inheritance)
// ---------------------------------------------------------------------------

/**
 * Build the synthetic memory message that heads a compacted conversation.
 * Produces an `assistant`-role message wrapped in `<context_summary>` tags
 * so reload and inheritance paths can recognize it via
 * {@link getSummaryFromContextMessage}.
 */
export function createContextSummaryMessage(summary: string): Message {
  const message: Message = {
    role: "assistant",
    content: [
      {
        type: "text",
        text: `${CONTEXT_SUMMARY_MARKER}\n${summary}\n${CONTEXT_SUMMARY_CLOSE}`,
      },
    ],
  };
  INTERNAL_CONTEXT_SUMMARY_MESSAGES.add(message);
  return message;
}

export function getSummaryFromContextMessage(
  message: Message | undefined,
): string | null {
  if (!message) return null;
  const text = extractText(message.content).trim();
  if (!text.startsWith(CONTEXT_SUMMARY_MARKER)) return null;
  if (!INTERNAL_CONTEXT_SUMMARY_MESSAGES.has(message)) return null;
  let inner = text.slice(CONTEXT_SUMMARY_MARKER.length);
  const closeIdx = inner.lastIndexOf(CONTEXT_SUMMARY_CLOSE);
  if (closeIdx !== -1) inner = inner.slice(0, closeIdx);
  return inner.trim();
}

function extractText(content: ContentBlock[]): string {
  return content
    .filter(
      (b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text",
    )
    .map((b) => b.text)
    .join("\n");
}

// ---------------------------------------------------------------------------
// ContextWindowManager
// ---------------------------------------------------------------------------

export class ContextWindowManager {
  private readonly provider: Provider;
  private config: ContextWindowConfig;
  private readonly toolTokenBudget: number;
  private readonly conversationId: string | undefined;
  private readonly resolveTools:
    | (() => ToolDefinition[] | undefined)
    | undefined;
  /**
   * Number of leading messages that are non-persisted (injected inherited
   * context from a parent conversation). The compactor subtracts this from
   * `compactedMessages` so `compactedPersistedMessages` only reflects DB
   * rows. Decremented after a successful compaction.
   */
  private _nonPersistedPrefixCount = 0;
  /**
   * Reducer state for the in-progress overflow-recovery ladder, held across
   * the successive {@link reduceOverflowOneRung} calls of a single turn so the
   * ladder advances one rung per call. Reset to `undefined` at each turn
   * boundary via {@link resetOverflowRecovery} so a new turn starts the ladder
   * from the emergency rung.
   */
  private _overflowReducerState: ReducerState | undefined;
  /**
   * The corrected compaction target and the prompt-token estimate it was
   * derived from, computed once against the overflowing prompt on the first
   * rung of a turn and reused across that turn's later rungs. The correction
   * captures the estimator error the provider's actual token count revealed at
   * the moment of overflow; re-deriving it against an already-reduced prompt
   * would divide the original actual-token count by a smaller estimate and
   * drive the target ever lower. Reset with {@link resetOverflowRecovery}.
   */
  private _overflowTurnTarget:
    | { targetTokens: number; estimatedInputTokens: number }
    | undefined;

  constructor(options: ContextWindowManagerOptions) {
    this.provider = options.provider;
    this.config = options.config;
    this.toolTokenBudget = options.toolTokenBudget ?? 0;
    this.conversationId = options.conversationId;
    this.resolveTools = options.resolveTools;
  }

  updateConfig(config: ContextWindowConfig): void {
    this.config = config;
  }

  /**
   * Clear the overflow-recovery ladder so the next {@link reduceOverflowOneRung}
   * call starts a fresh ladder from the emergency rung. Called at the turn
   * boundary.
   */
  resetOverflowRecovery(): void {
    this._overflowReducerState = undefined;
    this._overflowTurnTarget = undefined;
  }

  /** Leading non-persisted inherited-context messages the compactor preserves. */
  get nonPersistedPrefixCount(): number {
    return this._nonPersistedPrefixCount;
  }

  /**
   * Seed the non-persisted inherited-context prefix when a forked/sub
   * conversation inherits its parent's in-memory context. The compactor folds
   * this prefix into the summary and {@link consumeCompactionState} decrements
   * it as the leading messages are compacted away.
   */
  seedNonPersistedPrefix(count: number): void {
    this._nonPersistedPrefixCount = count;
  }

  private get estimationProviderName(): string {
    return this.provider.tokenEstimationProvider ?? this.provider.name;
  }

  private get systemPrompt(): string {
    const conversation = findConversationOrSubagent(this.conversationId);
    return conversation?.systemPrompt ?? "";
  }

  private resolveCompactionConfig(): CompactionConfig {
    return getConfig().compaction;
  }

  get maxInputTokens(): number {
    return this.config.maxInputTokens;
  }

  /**
   * Estimate the prompt-token cost of `messages` using the same path as the
   * auto-compaction pre-check. Clears the system-prompt cache so the next
   * turn re-resolves it (the system prompt is lazy and may have changed).
   */
  estimateInputTokens(messages: Message[]): number {
    return estimatePromptTokens(messages, this.systemPrompt, {
      providerName: this.estimationProviderName,
      toolTokenBudget: this.toolTokenBudget,
    });
  }

  /**
   * The resolved system prompt and tool definitions for the current turn —
   * the same composition {@link estimateInputTokens} sizes against. Exposed as
   * plain data so the daemon can run an out-of-band provider `count_tokens`
   * request without re-deriving the prompt; the count call itself lives on the
   * daemon, not this plugin.
   */
  get tokenCountInputs(): {
    systemPrompt: string;
    tools: ToolDefinition[] | undefined;
  } {
    return { systemPrompt: this.systemPrompt, tools: this.resolveTools?.() };
  }

  /**
   * Cheap pre-check — estimate the current token count and compare against
   * `compaction.autoThreshold`. Callers pass the estimate back through
   * `precomputedEstimate` on the {@link maybeCompact} call to avoid
   * re-tokenizing the same history twice.
   */
  shouldCompact(messages: Message[]): ShouldCompactResult {
    const compaction = this.resolveCompactionConfig();
    if (!compaction.enabled) return { needed: false, estimatedTokens: 0 };
    const estimated = estimatePromptTokens(messages, this.systemPrompt, {
      providerName: this.estimationProviderName,
      toolTokenBudget: this.toolTokenBudget,
    });
    const threshold = Math.floor(
      this.config.maxInputTokens * compaction.autoThreshold,
    );
    return { needed: estimated >= threshold, estimatedTokens: estimated };
  }

  async maybeCompact(
    messages: Message[],
    signal?: AbortSignal,
    options?: ContextWindowCompactOptions,
  ): Promise<ContextWindowResult> {
    return await this._maybeCompact(messages, signal, options);
  }

  /**
   * Advance the context-overflow reduction ladder by one rung against
   * `messages`, holding the reducer state across the successive calls of a
   * single turn (reset via {@link resetOverflowRecovery}). The compaction
   * target is the manager's overflow preflight budget, lowered in proportion
   * to the estimator error the provider's actual token count reveals, so the
   * reduced history lands under the provider's true ceiling rather than the
   * under-counted estimate.
   */
  async reduceOverflowOneRung(
    messages: Message[],
    options: OverflowRecoveryRungOptions,
    signal?: AbortSignal,
  ): Promise<ReducerStepResult> {
    return await this._reduceOverflowOneRung(messages, options, signal);
  }

  /**
   * Drive the context-overflow reduction ladder one rung against `messages`
   * and adapt the rung into a {@link ContextWindowResult} the agent loop's
   * compaction path consumes. Resolves the auto-compress-latest-turn
   * permission from the overflow policy — the manager owns that policy call,
   * the ladder never makes it — and surfaces the rung's injection mode,
   * terminal auto-compress flag, and exhaustion so the loop can re-inject at
   * the chosen volume and classify the terminal exit when recovery runs out.
   */
  async recoverContextOverflow(
    messages: Message[],
    options: OverflowRecoveryOptions,
    signal?: AbortSignal,
  ): Promise<ContextWindowResult> {
    const allowAutoCompressLatestTurn =
      resolveOverflowAction({
        overflowRecovery: this.config.overflowRecovery,
        isInteractive: options.isInteractive,
      }) === "auto_compress_latest_turn";
    const step = await this.reduceOverflowOneRung(
      messages,
      {
        actualTokens: options.actualTokens,
        allowAutoCompressLatestTurn,
        overrideProfile: options.overrideProfile,
        actorTrustClass: options.actorTrustClass,
      },
      signal,
    );
    return this.overflowStepToResult(step, messages);
  }

  /**
   * Adapt a reduction-ladder {@link ReducerStepResult} into the
   * {@link ContextWindowResult} shape the agent loop's compaction path
   * consumes. A summary rung carries a full compaction result (with the
   * durable-commit and circuit-breaker fields); the non-summary rungs
   * (truncation / media stubbing / injection downgrade) only transform the
   * in-memory history, so they map to a no-op result that still propagates the
   * reduced messages. Both forward the ladder's injection mode, exhaustion, and
   * whether the terminal auto-compress rung was applied.
   */
  private overflowStepToResult(
    step: ReducerStepResult,
    basis: Message[],
  ): ContextWindowResult {
    const autoCompressApplied = step.state.appliedTiers.includes(
      "auto_compress_latest_turn",
    );
    const base =
      step.compactionResult ??
      noopResult(step.messages, step.estimatedTokens, {
        maxInputTokens: this.config.maxInputTokens,
        thresholdTokens: Math.floor(
          this.config.maxInputTokens *
            this.resolveCompactionConfig().autoThreshold,
        ),
        reason: `overflow recovery: ${step.tier}`,
      });
    return {
      ...base,
      messages: step.messages,
      estimatedInputTokens: step.estimatedTokens,
      previousEstimatedInputTokens: this.estimateInputTokens(basis),
      injectionMode: step.state.injectionMode,
      autoCompressApplied,
      exhausted: step.state.exhausted,
    };
  }

  private async _reduceOverflowOneRung(
    messages: Message[],
    options: OverflowRecoveryRungOptions,
    signal?: AbortSignal,
  ): Promise<ReducerStepResult> {
    if (this.conversationId == null) {
      throw new Error(
        "ContextWindowManager has no conversationId — cannot run overflow recovery",
      );
    }
    if (!this._overflowReducerState) {
      this._overflowReducerState = createInitialReducerState();
      this._overflowTurnTarget = this.deriveOverflowTurnTarget(
        messages,
        options.actualTokens,
      );
    }
    const { targetTokens, estimatedInputTokens } = this._overflowTurnTarget!;

    const config: ReducerConfig = {
      providerName: this.estimationProviderName,
      systemPrompt: this.systemPrompt,
      contextWindow: this.config,
      targetTokens,
      toolTokenBudget: this.resolveTurnToolTokenBudget(),
      conversationId: this.conversationId,
      overrideProfile: options.overrideProfile ?? null,
      actorTrustClass: options.actorTrustClass,
      previousEstimatedInputTokens: estimatedInputTokens,
      maxMiddleTierAttempts: this.config.overflowRecovery.maxAttempts,
      allowAutoCompressLatestTurn: options.allowAutoCompressLatestTurn,
    };

    const step = await reduceContextOverflow(
      messages,
      config,
      this._overflowReducerState,
      signal,
    );
    this._overflowReducerState = step.state;
    return step;
  }

  /**
   * Compute the corrected compaction target for a turn's overflow recovery:
   * the overflow preflight budget lowered in proportion to the estimator error
   * the provider's actual token count reveals, so the reduced history lands
   * under the provider's true ceiling rather than the under-counted estimate.
   */
  private deriveOverflowTurnTarget(
    messages: Message[],
    actualTokens: number | null,
  ): { targetTokens: number; estimatedInputTokens: number } {
    const estimatedInputTokens = estimatePromptTokens(
      messages,
      this.systemPrompt,
      {
        providerName: this.estimationProviderName,
        toolTokenBudget: this.resolveTurnToolTokenBudget(),
      },
    );
    const { targetTokens, estimationErrorRatio } =
      computeCorrectedOverflowTarget({
        preflightBudget: this.resolveOverflowPreflightBudget(messages.length),
        actualTokens,
        estimatedTokens: estimatedInputTokens,
      });
    if (estimationErrorRatio != null) {
      log.warn(
        {
          actualTokens,
          estimatedTokens: estimatedInputTokens,
          estimationErrorRatio: estimationErrorRatio.toFixed(2),
          targetTokens,
        },
        "Adjusting overflow compaction target based on observed estimation error",
      );
    }
    return { targetTokens, estimatedInputTokens };
  }

  /**
   * Tool-token budget for the current turn's overflow recovery. Prefers the
   * live tool set resolved for the turn — matching what the loop sends to the
   * provider — and falls back to the constructor-time snapshot when no
   * resolver is wired (legacy test paths, ad-hoc instantiation).
   */
  private resolveTurnToolTokenBudget(): number {
    const tools = this.resolveTools?.();
    return tools ? estimateToolsTokens(tools) : this.toolTokenBudget;
  }

  /**
   * The token budget overflow recovery compacts below, derived from the
   * manager's configured max-input cap and overflow-recovery safety margin.
   * Long histories (> 50 messages) get a wider margin so the reduced prompt
   * keeps clearance under the provider's true ceiling.
   */
  private resolveOverflowPreflightBudget(messageCount: number): number {
    const baseSafetyMargin = this.config.overflowRecovery.safetyMarginRatio;
    const safetyMargin =
      messageCount > 50 ? Math.max(baseSafetyMargin, 0.15) : baseSafetyMargin;
    return Math.floor(this.config.maxInputTokens * (1 - safetyMargin));
  }

  /**
   * Low-watermark token budget a compaction pass aims to land the rebuilt
   * history at or below. Derived from `contextWindow.targetBudgetRatio` (the
   * fraction of the window to retain after compaction) minus the summary's own
   * reserve (`summaryBudgetRatio`), so the post-compaction total — summary plus
   * verbatim tail — fits the target. Clamped meaningfully below the
   * auto-threshold success gate: a target at or above the gate would defeat the
   * purpose (a pass could "succeed" while landing a hair under the trigger and
   * thrash on the next tick), so it is pulled down to at most 80% of the gate.
   */
  private resolveCompactionTargetTokens(thresholdTokens: number): number {
    const { maxInputTokens, targetBudgetRatio, summaryBudgetRatio } =
      this.config;
    const verbatimRatio = Math.max(
      0,
      targetBudgetRatio - (summaryBudgetRatio ?? 0),
    );
    const raw = Math.floor(maxInputTokens * verbatimRatio);
    const ceiling = Math.floor(thresholdTokens * 0.8);
    return Math.max(1, Math.min(raw, ceiling));
  }

  private async _maybeCompact(
    messages: Message[],
    signal?: AbortSignal,
    options?: ContextWindowCompactOptions,
  ): Promise<ContextWindowResult> {
    const compaction = this.resolveCompactionConfig();
    const previousEstimatedInputTokens =
      options?.precomputedEstimate ??
      estimatePromptTokens(messages, this.systemPrompt, {
        providerName: this.estimationProviderName,
        toolTokenBudget: this.toolTokenBudget,
      });
    const thresholdTokens = Math.floor(
      this.config.maxInputTokens * compaction.autoThreshold,
    );

    if (!compaction.enabled) {
      return noopResult(messages, previousEstimatedInputTokens, {
        maxInputTokens: this.config.maxInputTokens,
        thresholdTokens,
        reason: "compaction disabled",
      });
    }

    if (this.conversationId == null) {
      // The compactor needs the conversation id to look up image
      // attachments and DB timestamps. If we don't have one (legacy test
      // path, ad-hoc instantiation), skip — never fabricate one.
      log.warn(
        "ContextWindowManager has no conversationId — skipping compaction",
      );
      return noopResult(messages, previousEstimatedInputTokens, {
        maxInputTokens: this.config.maxInputTokens,
        thresholdTokens,
        reason: "no conversation id",
      });
    }

    // Shared compactor args for every pass in this call. `targetTokens` is
    // intentionally absent — the fixed-boundary path never applies a budget
    // forward-cut, and the auto path adds it per call site.
    const baseArgs: CompactionRunArgs = {
      conversationId: this.conversationId,
      messages,
      provider: this.provider,
      systemPrompt: this.systemPrompt,
      tools: this.resolveTools?.(),
      compaction,
      maxInputTokens: this.config.maxInputTokens,
      previousEstimatedInputTokens,
      force: options?.force,
      signal,
      overrideProfile: options?.overrideProfile ?? null,
      actorTrustClass: options?.actorTrustClass,
      nonPersistedPrefixCount: this.resolveNonPersistedPrefixCount(messages),
    };

    // Caller-fixed boundary ("summarize up to here"): one compactor pass at
    // the user's chosen cut. No threshold gate (the user asked, regardless of
    // fullness), no target budget (the boundary is not a budget outcome), and
    // no retry ladder (a retry would re-summarize the already-summarized
    // history past the boundary the user picked).
    if (options?.fixedTailStartIndex != null) {
      const result = await runAssistantDrivenCompaction({
        ...baseArgs,
        force: true,
        fixedTailStartIndex: options.fixedTailStartIndex,
      });
      if (!result.compacted) return result;
      return {
        ...result,
        estimatedInputTokens: this.settleCompactionAttempt(result),
      };
    }

    if (!options?.force && previousEstimatedInputTokens < thresholdTokens) {
      return noopResult(messages, previousEstimatedInputTokens, {
        maxInputTokens: this.config.maxInputTokens,
        thresholdTokens,
        reason: "below auto threshold",
      });
    }

    const targetTokens = this.resolveCompactionTargetTokens(thresholdTokens);

    // Retry budget for the compactor itself. Lives here (not in the
    // orchestrator/agent loop) because the question "did this compactor
    // make enough progress?" is a compaction-internal concern. The agent
    // loop only needs to know the binary outcome — drop below threshold,
    // or signal `exhausted` so reducers escalate.
    const maxAttempts = this.config.overflowRecovery.maxAttempts;

    let result = await runAssistantDrivenCompaction({
      ...baseArgs,
      targetTokens,
    });

    // Compactor early-returned without doing any work (e.g. no eligible
    // messages, summary failed, disabled mid-way). Nothing to retry.
    if (!result.compacted) return result;

    let estimatedInputTokens = this.settleCompactionAttempt(result);

    // If a single pass already cleared the auto-threshold, ship it.
    if (estimatedInputTokens < thresholdTokens) {
      return { ...result, estimatedInputTokens };
    }

    // The deterministic forward-cut already advanced to the tail floor (the
    // most recent complete exchange) and still couldn't fit the budget — the
    // verbatim tail alone is over budget (a tool-heavy in-flight turn). A
    // second full-context pass would re-derive the same floor and free
    // nothing, just paying another full cache write. Stop now and surface
    // `exhausted` so reducers escalate instead of thrashing the compactor.
    if (result.tailFloorReached) {
      return { ...result, estimatedInputTokens, exhausted: true };
    }

    // Still above the threshold after one pass — retry on the compacted
    // history, up to the remaining budget. Each retry runs against the
    // PREVIOUS attempt's output, building a tighter summary each time.
    // Bail early as soon as a pass fails to reduce — that's a stuck
    // compactor and another attempt won't help.
    let previousEstimate = estimatedInputTokens;
    for (let attempt = 2; attempt <= maxAttempts; attempt++) {
      const nextResult = await runAssistantDrivenCompaction({
        ...baseArgs,
        targetTokens,
        messages: result.messages,
        previousEstimatedInputTokens: previousEstimate,
        nonPersistedPrefixCount: this.resolveNonPersistedPrefixCount(
          result.messages,
        ),
      });
      if (!nextResult.compacted) break;
      const nextEstimate = this.settleCompactionAttempt(nextResult);
      result = mergeCompactionResults(result, nextResult);
      estimatedInputTokens = nextEstimate;
      if (estimatedInputTokens < thresholdTokens) {
        return { ...result, estimatedInputTokens };
      }
      // Forward-cut hit the floor and still over budget — same stop condition
      // as the first pass: another retry lands on the same floor.
      if (nextResult.tailFloorReached) break;
      // Non-productive (compacted but didn't shrink) — stuck compactor.
      if (estimatedInputTokens >= previousEstimate) break;
      previousEstimate = estimatedInputTokens;
    }

    // Out of attempts or stuck — surface `exhausted` so the orchestrator
    // can escalate to reducer tiers instead of re-running the compactor.
    return { ...result, estimatedInputTokens, exhausted: true };
  }

  /**
   * Emergency mid-turn compaction — summarize everything before the last
   * tool_use/tool_result pair and let the agent continue with
   * `[summary, last_tool_call, last_tool_result]`. Used as a recovery rung
   * after the provider rejects a turn for context overflow. The manager
   * supplies the provider, system prompt, token budget, conversation id, and
   * non-persisted prefix count it already owns; the caller provides only the
   * overflow-specific inputs.
   */
  async emergencyCompact(
    messages: Message[],
    options: EmergencyCompactOptions,
    signal?: AbortSignal,
  ): Promise<CompactionRunResult> {
    if (this.conversationId == null) {
      throw new Error(
        "ContextWindowManager has no conversationId — cannot run emergency compaction",
      );
    }
    return await runEmergencyCompaction({
      conversationId: this.conversationId,
      messages,
      provider: this.provider,
      systemPrompt: this.systemPrompt,
      tools: undefined,
      compaction: this.resolveCompactionConfig(),
      maxInputTokens: this.config.maxInputTokens,
      previousEstimatedInputTokens: options.previousEstimatedInputTokens,
      force: true,
      signal,
      overrideProfile: options.overrideProfile ?? null,
      nonPersistedPrefixCount: this.resolveNonPersistedPrefixCount(messages),
    });
  }

  /**
   * Recompute the prompt-token estimate against the post-compaction
   * message array. The compactor returns a conservative placeholder; the
   * orchestrator needs the real number for its next budget decision.
   */
  private recomputePostCompactionEstimate(
    messages: Message[],
    fallback: number,
  ): number {
    try {
      return estimatePromptTokens(messages, this.systemPrompt, {
        providerName: this.estimationProviderName,
        toolTokenBudget: this.toolTokenBudget,
      });
    } catch (err) {
      log.warn({ err }, "Post-compaction token estimate failed");
      return fallback;
    }
  }

  /**
   * Leading non-persisted messages of `messages` for persisted-count
   * accounting: the seeded fork-inherited prefix, or the synthetic
   * summary/retained-images head minted by conversation rehydration
   * (`createContextSummaryMessage`) or a prior compaction pass — none of
   * which have DB rows. `max`, not `+`: a fork-inherited prefix already
   * counts its own inherited summary head.
   */
  private resolveNonPersistedPrefixCount(messages: Message[]): number {
    let syntheticHead = 0;
    while (
      syntheticHead < messages.length &&
      (getSummaryFromContextMessage(messages[syntheticHead]) != null ||
        isSyntheticCompactionMessage(messages[syntheticHead]))
    ) {
      syntheticHead++;
    }
    return Math.max(this._nonPersistedPrefixCount, syntheticHead);
  }

  /**
   * Post-pass bookkeeping shared by every productive compaction attempt:
   * recompute the prompt estimate against the rebuilt history and settle
   * the non-persisted prefix count the pass consumed. Returns the fresh
   * estimate.
   */
  private settleCompactionAttempt(result: ContextWindowResult): number {
    const estimatedInputTokens = this.recomputePostCompactionEstimate(
      result.messages,
      result.estimatedInputTokens,
    );
    this.consumeCompactionState(result.compactedMessages);
    return estimatedInputTokens;
  }

  /**
   * Decrement the non-persisted prefix bookkeeping after a productive
   * compaction. Called once per successful internal attempt so multi-attempt
   * runs keep the count honest as the leading injected messages get folded
   * into the summary.
   */
  private consumeCompactionState(compactedMessages: number): void {
    const compactedAway = Math.min(
      this._nonPersistedPrefixCount,
      compactedMessages,
    );
    this._nonPersistedPrefixCount = Math.max(
      0,
      this._nonPersistedPrefixCount - compactedAway,
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Combine the result of a follow-up compaction attempt with the running
 * aggregate so the orchestrator sees cumulative work — total messages
 * folded into the summary, total summary LLM calls, total token spend —
 * across all internal retries. Content fields (the new messages array,
 * latest summary text, latest estimate) take the `next` attempt's value.
 */
function mergeCompactionResults(
  prev: ContextWindowResult,
  next: ContextWindowResult,
): ContextWindowResult {
  return {
    ...next,
    previousEstimatedInputTokens: prev.previousEstimatedInputTokens,
    compactedMessages: prev.compactedMessages + next.compactedMessages,
    compactedPersistedMessages:
      prev.compactedPersistedMessages + next.compactedPersistedMessages,
    summaryCalls: prev.summaryCalls + next.summaryCalls,
    summaryInputTokens: prev.summaryInputTokens + next.summaryInputTokens,
    summaryOutputTokens: prev.summaryOutputTokens + next.summaryOutputTokens,
    summaryCacheCreationInputTokens:
      (prev.summaryCacheCreationInputTokens ?? 0) +
      (next.summaryCacheCreationInputTokens ?? 0),
    summaryCacheReadInputTokens:
      (prev.summaryCacheReadInputTokens ?? 0) +
      (next.summaryCacheReadInputTokens ?? 0),
    summaryRawResponses: [
      ...(prev.summaryRawResponses ?? []),
      ...(next.summaryRawResponses ?? []),
    ],
    // Any failure across attempts taints the run for the circuit breaker.
    summaryFailed:
      next.summaryFailed === true || prev.summaryFailed === true
        ? true
        : (next.summaryFailed ?? prev.summaryFailed),
  };
}

function noopResult(
  messages: Message[],
  estimated: number,
  opts: { maxInputTokens: number; thresholdTokens: number; reason: string },
): ContextWindowResult {
  return {
    messages,
    compacted: false,
    previousEstimatedInputTokens: estimated,
    estimatedInputTokens: estimated,
    maxInputTokens: opts.maxInputTokens,
    thresholdTokens: opts.thresholdTokens,
    compactedMessages: 0,
    compactedPersistedMessages: 0,
    summaryCalls: 0,
    summaryInputTokens: 0,
    summaryOutputTokens: 0,
    summaryModel: "",
    summaryText: getSummaryFromContextMessage(messages[0]) ?? "",
    reason: opts.reason,
  };
}

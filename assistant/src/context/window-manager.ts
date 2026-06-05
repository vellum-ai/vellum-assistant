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
import { getConfig } from "../config/loader.js";
import type { CompactionConfig } from "../config/schemas/compaction.js";
import type { LLMCallSite } from "../config/schemas/llm.js";
import type { ContextWindowConfig } from "../config/types.js";
import type {
  ContentBlock,
  Message,
  Provider,
  ToolDefinition,
} from "../providers/types.js";
import type { TrustClass } from "../runtime/actor-trust-resolver.js";
import { getLogger } from "../util/logger.js";
import {
  type CompactionRunArgs,
  runAssistantDrivenCompaction,
} from "./compactor.js";
import { estimatePromptTokens } from "./token-estimator.js";

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
}

export interface ContextWindowManagerOptions {
  provider: Provider;
  systemPrompt: string | (() => string);
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
  private readonly _systemPrompt: string | (() => string);
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
  nonPersistedPrefixCount = 0;
  summaryIsInjected = false;
  private _resolvedSystemPrompt: string | undefined;

  constructor(options: ContextWindowManagerOptions) {
    this.provider = options.provider;
    this._systemPrompt = options.systemPrompt;
    this.config = options.config;
    this.toolTokenBudget = options.toolTokenBudget ?? 0;
    this.conversationId = options.conversationId;
    this.resolveTools = options.resolveTools;
  }

  updateConfig(config: ContextWindowConfig): void {
    this.config = config;
  }

  private get estimationProviderName(): string {
    return this.provider.tokenEstimationProvider ?? this.provider.name;
  }

  private get systemPrompt(): string {
    if (this._resolvedSystemPrompt !== undefined)
      return this._resolvedSystemPrompt;
    const resolved =
      typeof this._systemPrompt === "function"
        ? this._systemPrompt()
        : this._systemPrompt;
    this._resolvedSystemPrompt = resolved;
    return resolved;
  }

  private clearSystemPromptCache(): void {
    this._resolvedSystemPrompt = undefined;
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
    try {
      return estimatePromptTokens(messages, this.systemPrompt, {
        providerName: this.estimationProviderName,
        toolTokenBudget: this.toolTokenBudget,
      });
    } finally {
      this.clearSystemPromptCache();
    }
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
    try {
      const estimated = estimatePromptTokens(messages, this.systemPrompt, {
        providerName: this.estimationProviderName,
        toolTokenBudget: this.toolTokenBudget,
      });
      const threshold = Math.floor(
        this.config.maxInputTokens * compaction.autoThreshold,
      );
      return { needed: estimated >= threshold, estimatedTokens: estimated };
    } finally {
      this.clearSystemPromptCache();
    }
  }

  async maybeCompact(
    messages: Message[],
    signal?: AbortSignal,
    options?: ContextWindowCompactOptions,
  ): Promise<ContextWindowResult> {
    try {
      return await this._maybeCompact(messages, signal, options);
    } finally {
      this.clearSystemPromptCache();
    }
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

    if (!options?.force && previousEstimatedInputTokens < thresholdTokens) {
      return noopResult(messages, previousEstimatedInputTokens, {
        maxInputTokens: this.config.maxInputTokens,
        thresholdTokens,
        reason: "below auto threshold",
      });
    }

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
      nonPersistedPrefixCount: this.nonPersistedPrefixCount,
    };

    // Retry budget for the compactor itself. Lives here (not in the
    // orchestrator/agent loop) because the question "did this compactor
    // make enough progress?" is a compaction-internal concern. The agent
    // loop only needs to know the binary outcome — drop below threshold,
    // or signal `exhausted` so reducers escalate.
    const maxAttempts = this.config.overflowRecovery.maxAttempts;

    let result = await runAssistantDrivenCompaction(baseArgs);

    // Compactor early-returned without doing any work (e.g. no eligible
    // messages, summary failed, disabled mid-way). Nothing to retry.
    if (!result.compacted) return result;

    let estimatedInputTokens = this.recomputePostCompactionEstimate(
      result.messages,
      result.estimatedInputTokens,
    );
    this.consumeCompactionState(result.compactedMessages);

    // If a single pass already cleared the auto-threshold, ship it.
    if (estimatedInputTokens < thresholdTokens) {
      return { ...result, estimatedInputTokens };
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
        messages: result.messages,
        previousEstimatedInputTokens: previousEstimate,
        nonPersistedPrefixCount: this.nonPersistedPrefixCount,
      });
      if (!nextResult.compacted) break;
      const nextEstimate = this.recomputePostCompactionEstimate(
        nextResult.messages,
        nextResult.estimatedInputTokens,
      );
      this.consumeCompactionState(nextResult.compactedMessages);
      result = mergeCompactionResults(result, nextResult);
      estimatedInputTokens = nextEstimate;
      if (estimatedInputTokens < thresholdTokens) {
        return { ...result, estimatedInputTokens };
      }
      // Non-productive (compacted but didn't shrink) — stuck compactor.
      if (estimatedInputTokens >= previousEstimate) break;
      previousEstimate = estimatedInputTokens;
    }

    // Out of attempts or stuck — surface `exhausted` so the orchestrator
    // can escalate to reducer tiers instead of re-running the compactor.
    return { ...result, estimatedInputTokens, exhausted: true };
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
   * Decrement the non-persisted prefix bookkeeping and clear the
   * injected-summary flag after a productive compaction. Called once per
   * successful internal attempt so multi-attempt runs keep the count
   * honest as the leading injected messages get folded into the summary.
   */
  private consumeCompactionState(compactedMessages: number): void {
    const compactedAway = Math.min(
      this.nonPersistedPrefixCount,
      compactedMessages,
    );
    this.nonPersistedPrefixCount = Math.max(
      0,
      this.nonPersistedPrefixCount - compactedAway,
    );
    this.summaryIsInjected = false;
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

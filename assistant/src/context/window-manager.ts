import type { ContextWindowConfig } from "../config/types.js";
import type {
  ContentBlock,
  ImageContent,
  Message,
  Provider,
} from "../providers/types.js";
import { getLogger } from "../util/logger.js";
import { safeStringSlice } from "../util/unicode.js";
import {
  estimateContentBlockTokens,
  estimatePromptTokens,
  estimateTextTokens,
} from "./token-estimator.js";
import { truncateToolResultsAcrossHistory } from "./tool-result-truncation.js";

const log = getLogger("context-window");

export const CONTEXT_SUMMARY_MARKER = "<context_summary>";
const MAX_BLOCK_PREVIEW_CHARS = 3000;
const MAX_FALLBACK_SUMMARY_CHARS = 12000;
const COMPACTION_COOLDOWN_MS = 2 * 60 * 1000;
const MIN_GAIN_TOKENS_DURING_COOLDOWN = 1200;
const SEVERE_PRESSURE_RATIO = 0.95;
const COMPACTION_TOOL_RESULT_MAX_CHARS = 6_000;
const MIN_COMPACTABLE_PERSISTED_MESSAGES = 2;
const INTERNAL_CONTEXT_SUMMARY_MESSAGES = new WeakSet<Message>();

const SUMMARY_SYSTEM_PROMPT = [
  "You compress long assistant conversations into durable working memory.",
  "Focus on actionable state, not prose.",
  "Preserve concrete facts: goals, constraints, decisions, pending questions, file paths, commands, errors, and TODOs.",
  "Remove repetition and stale details that were superseded.",
  "Thread anchors: when a compacted message is the parent of a thread whose replies survive in the retained context, preserve the parent's text verbatim — do not summarize or paraphrase it. Reactions on such anchors may be aggregated (e.g., \"three users reacted\").",
  "Return concise markdown using these section headers exactly:",
  "## Goals",
  "## Constraints",
  "## Decisions",
  "## Open Conversations",
  "## Key Artifacts",
  "## Recent Progress",
].join("\n");

export interface ContextWindowResult {
  messages: Message[];
  compacted: boolean;
  previousEstimatedInputTokens: number;
  estimatedInputTokens: number;
  maxInputTokens: number;
  thresholdTokens: number;
  compactedMessages: number;
  compactedPersistedMessages: number;
  summaryCalls: number;
  summaryInputTokens: number;
  summaryOutputTokens: number;
  summaryModel: string;
  summaryCacheCreationInputTokens?: number;
  summaryCacheReadInputTokens?: number;
  summaryRawResponses?: unknown[];
  summaryText: string;
  reason?: string;
}

export interface ShouldCompactResult {
  needed: boolean;
  estimatedTokens: number;
}

export interface ContextWindowCompactOptions {
  lastCompactedAt?: number;
  /** Bypass the threshold check and force compaction. Used for context-too-large error recovery. */
  force?: boolean;
  /**
   * Override the minimum number of recent user turns to preserve.
   * Set to `0` for emergency recovery that can compact the entire history
   * (except the summary message itself). When omitted, the default floor
   * is `1` (or `8` when `conversationOriginChannel === "slack"`).
   */
  minKeepRecentUserTurns?: number;
  /**
   * Origin channel hint used when `minKeepRecentUserTurns` is omitted.
   * Slack-originated conversations bump the default keep floor so multi-turn
   * thread context (replies, quoted messages) is not summarized away too
   * aggressively. Explicit `minKeepRecentUserTurns` overrides this hint.
   */
  conversationOriginChannel?: string;
  /**
   * Override the target input token budget used for keep-boundary
   * projected-fit checks. Allows the caller to demand a stricter fit
   * than the normal `config.targetInputTokens` during forced recovery.
   */
  targetInputTokensOverride?: number;
  /**
   * Pre-computed token estimate from a prior `shouldCompact()` call.
   * When provided, `maybeCompact()` skips its own `estimatePromptTokens()`
   * call, avoiding a redundant O(history) tokenization pass.
   */
  precomputedEstimate?: number;
}

export interface ContextWindowManagerOptions {
  provider: Provider;
  systemPrompt: string | (() => string);
  config: ContextWindowConfig;
  /** Pre-computed tool token budget to include in all estimations. */
  toolTokenBudget?: number;
}

export class ContextWindowManager {
  private readonly provider: Provider;
  private readonly _systemPrompt: string | (() => string);
  private readonly config: ContextWindowConfig;
  private readonly toolTokenBudget: number;
  /**
   * Number of leading messages that are non-persisted (injected inherited
   * context from a parent conversation).  `countPersistedMessages` subtracts
   * this so `compactedPersistedMessages` only reflects DB-backed messages.
   * Set by `Conversation.injectInheritedContext` and consumed (decremented)
   * after a successful compaction pass.
   */
  nonPersistedPrefixCount = 0;
  /**
   * True when the message at index 0 is a context summary that was inherited
   * from a parent fork (i.e. injected as part of the non-persisted prefix),
   * rather than produced by this conversation's own compaction. The parent
   * summary sits at index 0 but is excluded from `compactableMessages` by
   * `summaryOffset`, so its slot in `nonPersistedPrefixCount` must be
   * accounted for separately. Cleared after the first compaction replaces
   * the parent summary with a child-owned one.
   */
  summaryIsInjected = false;
  /**
   * Cached resolved system prompt. Lazily populated on first access via the
   * `systemPrompt` getter and cleared after each compaction pass so the next
   * pass picks up any prompt changes.
   */
  private _resolvedSystemPrompt: string | undefined;

  constructor(options: ContextWindowManagerOptions) {
    this.provider = options.provider;
    this._systemPrompt = options.systemPrompt;
    this.config = options.config;
    this.toolTokenBudget = options.toolTokenBudget ?? 0;
  }

  /**
   * Provider key for the local token estimator. Wrapper providers (e.g.
   * OpenRouter routing to `anthropic/*`) override `tokenEstimationProvider`
   * so image/PDF sizing uses the same rules as the upstream API instead of
   * the generic `base64/4` fallback.
   */
  private get estimationProviderName(): string {
    return this.provider.tokenEstimationProvider ?? this.provider.name;
  }

  /** Lazily resolve and cache the system prompt for the duration of a compaction pass. */
  private get systemPrompt(): string {
    if (this._resolvedSystemPrompt !== undefined) {
      return this._resolvedSystemPrompt;
    }
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

  /**
   * Cheap pre-check: returns whether the estimated token count exceeds
   * the compaction threshold, along with the estimated token count so
   * callers can pass it into `maybeCompact()` via `precomputedEstimate`
   * to avoid a redundant tokenization pass.
   */
  shouldCompact(messages: Message[]): ShouldCompactResult {
    if (!this.config.enabled) return { needed: false, estimatedTokens: 0 };
    try {
      const estimated = estimatePromptTokens(messages, this.systemPrompt, {
        providerName: this.estimationProviderName,
        toolTokenBudget: this.toolTokenBudget,
      });
      const threshold = Math.floor(
        this.config.maxInputTokens * this.config.compactThreshold,
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
    const previousEstimatedInputTokens =
      options?.precomputedEstimate ??
      estimatePromptTokens(messages, this.systemPrompt, {
        providerName: this.estimationProviderName,
        toolTokenBudget: this.toolTokenBudget,
      });
    const thresholdTokens = Math.floor(
      this.config.maxInputTokens * this.config.compactThreshold,
    );
    const existingSummary = getSummaryFromContextMessage(messages[0]);

    if (!this.config.enabled) {
      return {
        messages,
        compacted: false,
        previousEstimatedInputTokens,
        estimatedInputTokens: previousEstimatedInputTokens,
        maxInputTokens: this.config.maxInputTokens,
        thresholdTokens,
        compactedMessages: 0,
        compactedPersistedMessages: 0,
        summaryCalls: 0,
        summaryInputTokens: 0,
        summaryOutputTokens: 0,
        summaryModel: "",
        summaryText: existingSummary ?? "",
        reason: "context window compaction disabled",
      };
    }

    if (!options?.force && previousEstimatedInputTokens < thresholdTokens) {
      return {
        messages,
        compacted: false,
        previousEstimatedInputTokens,
        estimatedInputTokens: previousEstimatedInputTokens,
        maxInputTokens: this.config.maxInputTokens,
        thresholdTokens,
        compactedMessages: 0,
        compactedPersistedMessages: 0,
        summaryCalls: 0,
        summaryInputTokens: 0,
        summaryOutputTokens: 0,
        summaryModel: "",
        summaryText: existingSummary ?? "",
        reason: "below compaction threshold",
      };
    }

    const summaryOffset = existingSummary != null ? 1 : 0;
    const userTurnStarts = collectUserTurnStartIndexes(messages);
    if (userTurnStarts.length === 0) {
      return {
        messages,
        compacted: false,
        previousEstimatedInputTokens,
        estimatedInputTokens: previousEstimatedInputTokens,
        maxInputTokens: this.config.maxInputTokens,
        thresholdTokens,
        compactedMessages: 0,
        compactedPersistedMessages: 0,
        summaryCalls: 0,
        summaryInputTokens: 0,
        summaryOutputTokens: 0,
        summaryModel: "",
        summaryText: existingSummary ?? "",
        reason: "no user turns available for compaction",
      };
    }

    const keepPlan = this.pickKeepBoundary(messages, userTurnStarts, {
      minKeepRecentUserTurns: options?.minKeepRecentUserTurns,
      targetInputTokensOverride: options?.targetInputTokensOverride,
      conversationOriginChannel: options?.conversationOriginChannel,
    });
    if (keepPlan.keepFromIndex <= summaryOffset) {
      // All turns fit after truncation projection, but the real in-memory
      // messages may still contain un-truncated tool results. Apply truncation
      // so the caller gets the token savings even without summarization.
      const { messages: truncatedMessages, truncatedCount } =
        truncateToolResultsAcrossHistory(
          messages,
          COMPACTION_TOOL_RESULT_MAX_CHARS,
        );
      const didTruncate = truncatedCount > 0;
      const estimatedAfterTruncation = didTruncate
        ? estimatePromptTokens(truncatedMessages, this.systemPrompt, {
            providerName: this.estimationProviderName,
            toolTokenBudget: this.toolTokenBudget,
          })
        : previousEstimatedInputTokens;
      return {
        messages: truncatedMessages,
        compacted: didTruncate,
        previousEstimatedInputTokens,
        estimatedInputTokens: estimatedAfterTruncation,
        maxInputTokens: this.config.maxInputTokens,
        thresholdTokens,
        compactedMessages: 0,
        compactedPersistedMessages: 0,
        summaryCalls: 0,
        summaryInputTokens: 0,
        summaryOutputTokens: 0,
        summaryModel: "",
        summaryText: existingSummary ?? "",
        reason: didTruncate
          ? "truncated tool results without summarization"
          : "unable to compact while keeping recent turns",
      };
    }

    const compactableMessages = messages.slice(
      summaryOffset,
      keepPlan.keepFromIndex,
    );
    if (compactableMessages.length === 0) {
      return {
        messages,
        compacted: false,
        previousEstimatedInputTokens,
        estimatedInputTokens: previousEstimatedInputTokens,
        maxInputTokens: this.config.maxInputTokens,
        thresholdTokens,
        compactedMessages: 0,
        compactedPersistedMessages: 0,
        summaryCalls: 0,
        summaryInputTokens: 0,
        summaryOutputTokens: 0,
        summaryModel: "",
        summaryText: existingSummary ?? "",
        reason: "no eligible messages to compact",
      };
    }

    // When the summary at index 0 was injected from a parent fork, it
    // contributes 1 to `nonPersistedPrefixCount` but is excluded from
    // `compactableMessages` by `summaryOffset`; subtract it here so the
    // remaining injected count lines up with compactableMessages. A summary
    // produced by this conversation's own prior compaction is not part of
    // `nonPersistedPrefixCount` (already decremented), so no subtraction.
    const injectedSummaryOffset = this.summaryIsInjected ? summaryOffset : 0;
    const injectedInCompactable = Math.min(
      Math.max(0, this.nonPersistedPrefixCount - injectedSummaryOffset),
      compactableMessages.length,
    );
    const compactedPersistedMessages =
      countPersistedMessages(compactableMessages) - injectedInCompactable;
    const rawProjectedMessages = [
      createContextSummaryMessage(existingSummary ?? "Projected summary"),
      ...messages.slice(keepPlan.keepFromIndex),
    ];
    const { messages: projectedMessages } = truncateToolResultsAcrossHistory(
      rawProjectedMessages,
      COMPACTION_TOOL_RESULT_MAX_CHARS,
    );
    const projectedInputTokens = estimatePromptTokens(
      projectedMessages,
      this.systemPrompt,
      {
        providerName: this.estimationProviderName,
        toolTokenBudget: this.toolTokenBudget,
      },
    );
    const projectedGainTokens = Math.max(
      0,
      previousEstimatedInputTokens - projectedInputTokens,
    );
    const severePressure =
      previousEstimatedInputTokens >=
      Math.floor(this.config.maxInputTokens * SEVERE_PRESSURE_RATIO);
    const lastCompactedAt = options?.lastCompactedAt;

    // Adaptive cooldown: conversations growing quickly (high projected gain) compact
    // sooner. Scale the cooldown inversely with the growth-rate multiplier, capped at
    // 1/4 of the base cooldown so we never check more than 4× as frequently.
    const growthRateMultiplier = Math.max(
      1,
      projectedGainTokens / MIN_GAIN_TOKENS_DURING_COOLDOWN,
    );
    const adaptiveCooldownMs = Math.max(
      COMPACTION_COOLDOWN_MS / 4,
      COMPACTION_COOLDOWN_MS / growthRateMultiplier,
    );
    const withinCooldown =
      typeof lastCompactedAt === "number" &&
      Date.now() - lastCompactedAt < adaptiveCooldownMs;

    // The adaptive cooldown is already tuned to be shorter for fast-growing
    // conversations (high projectedGainTokens → smaller adaptiveCooldownMs).
    // Removing the redundant MIN_GAIN_TOKENS_DURING_COOLDOWN guard here lets
    // that shorter cooldown actually gate compaction: high-growth conversations
    // break out of the cooldown sooner and compact more frequently.
    // force=true bypasses the cooldown so context-too-large recovery can always
    // attempt a compaction even within the cooldown window.
    if (withinCooldown && !severePressure && !options?.force) {
      log.debug(
        {
          projectedGainTokens,
          adaptiveCooldownMs,
          growthRateMultiplier,
          msSinceCompaction:
            typeof lastCompactedAt === "number"
              ? Date.now() - lastCompactedAt
              : null,
        },
        "Compaction cooldown active",
      );
      return {
        messages,
        compacted: false,
        previousEstimatedInputTokens,
        estimatedInputTokens: previousEstimatedInputTokens,
        maxInputTokens: this.config.maxInputTokens,
        thresholdTokens,
        compactedMessages: 0,
        compactedPersistedMessages: 0,
        summaryCalls: 0,
        summaryInputTokens: 0,
        summaryOutputTokens: 0,
        summaryModel: "",
        summaryText: existingSummary ?? "",
        reason: "compaction cooldown active",
      };
    }

    if (
      compactedPersistedMessages < MIN_COMPACTABLE_PERSISTED_MESSAGES &&
      !severePressure
    ) {
      return {
        messages,
        compacted: false,
        previousEstimatedInputTokens,
        estimatedInputTokens: previousEstimatedInputTokens,
        maxInputTokens: this.config.maxInputTokens,
        thresholdTokens,
        compactedMessages: 0,
        compactedPersistedMessages: 0,
        summaryCalls: 0,
        summaryInputTokens: 0,
        summaryOutputTokens: 0,
        summaryModel: "",
        summaryText: existingSummary ?? "",
        reason: "insufficient compactable persisted messages",
      };
    }

    const transcriptBlocks = this.capTranscriptBlocksToTokenBudget(
      serializeMessagesToContentBlocks(compactableMessages),
      existingSummary ?? "No previous summary.",
    );
    const summaryUpdate = await this.updateSummary(
      existingSummary ?? "No previous summary.",
      transcriptBlocks,
      signal,
    );
    const summary = summaryUpdate.summary;
    const summaryInputTokens = summaryUpdate.inputTokens;
    const summaryOutputTokens = summaryUpdate.outputTokens;
    const summaryModel = summaryUpdate.model;
    const summaryCacheCreationInputTokens =
      summaryUpdate.cacheCreationInputTokens;
    const summaryCacheReadInputTokens = summaryUpdate.cacheReadInputTokens;
    const summaryRawResponses: unknown[] = [];
    if (Array.isArray(summaryUpdate.rawResponse)) {
      summaryRawResponses.push(...summaryUpdate.rawResponse);
    } else if (summaryUpdate.rawResponse !== undefined) {
      summaryRawResponses.push(summaryUpdate.rawResponse);
    }
    const summaryCalls = 1;

    // Media (images, files) in kept turns is preserved naturally — those
    // turns are carried forward as-is and their token cost is already
    // accounted for by pickKeepBoundary's estimatePromptTokens call.
    // Images in compacted turns are passed to the summarizer so it can
    // describe their visual content in the summary text.
    const summaryMessage = createContextSummaryMessage(summary);

    const { messages: truncatedKeptMessages } =
      truncateToolResultsAcrossHistory(
        messages.slice(keepPlan.keepFromIndex),
        COMPACTION_TOOL_RESULT_MAX_CHARS,
      );
    const compactedMessages = [summaryMessage, ...truncatedKeptMessages];
    const estimatedInputTokens = estimatePromptTokens(
      compactedMessages,
      this.systemPrompt,
      {
        providerName: this.estimationProviderName,
        toolTokenBudget: this.toolTokenBudget,
      },
    );
    // Consume the injected prefix messages that were compacted away. When the
    // parent-injected summary was replaced by a freshly produced child summary,
    // also consume its slot (it was excluded from injectedInCompactable via
    // injectedSummaryOffset) and clear the flag so subsequent compactions treat
    // the summary at index 0 as child-owned.
    this.nonPersistedPrefixCount = Math.max(
      0,
      this.nonPersistedPrefixCount - injectedInCompactable - injectedSummaryOffset,
    );
    this.summaryIsInjected = false;

    log.info(
      {
        previousEstimatedInputTokens,
        estimatedInputTokens,
        compactedMessages: compactableMessages.length,
        compactedPersistedMessages,
        keepTurns: keepPlan.keepTurns,
        summaryCalls,
      },
      "Compacted conversation context window",
    );

    return {
      messages: compactedMessages,
      compacted: true,
      previousEstimatedInputTokens,
      estimatedInputTokens,
      maxInputTokens: this.config.maxInputTokens,
      thresholdTokens,
      compactedMessages: compactableMessages.length,
      compactedPersistedMessages,
      summaryCalls,
      summaryInputTokens,
      summaryOutputTokens,
      summaryModel,
      summaryCacheCreationInputTokens,
      summaryCacheReadInputTokens,
      summaryRawResponses,
      summaryText: summary,
    };
  }

  private get targetInputTokens(): number {
    return Math.floor(
      this.config.maxInputTokens *
        (this.config.targetBudgetRatio - this.config.summaryBudgetRatio),
    );
  }

  private pickKeepBoundary(
    messages: Message[],
    userTurnStarts: number[],
    opts?: {
      minKeepRecentUserTurns?: number;
      targetInputTokensOverride?: number;
      conversationOriginChannel?: string;
    },
  ): { keepFromIndex: number; keepTurns: number } {
    // Slack-originated conversations rely on multi-turn thread context
    // (reply chains, quoted messages, contextual references). Bump the
    // default keep floor for them so compaction does not summarize away
    // recent turns that the next reply may directly cite. Explicit
    // `minKeepRecentUserTurns` (including emergency `0`) wins.
    const defaultTurns = opts?.conversationOriginChannel === "slack" ? 8 : 1;
    const minFloor = Math.min(
      Math.max(0, Math.floor(opts?.minKeepRecentUserTurns ?? defaultTurns)),
      userTurnStarts.length,
    );
    const targetTokens =
      opts?.targetInputTokensOverride ?? this.targetInputTokens;

    // Binary search for the maximum keepTurns whose projected tokens fit
    // within the budget. Token count is monotonically non-decreasing with
    // keepTurns (more turns = more tokens), so binary search is valid.
    const projectedTokensForKeep = (turns: number): number => {
      const fromIndex =
        turns === 0
          ? messages.length
          : (userTurnStarts[userTurnStarts.length - turns] ?? messages.length);
      const rawProjected = [
        createContextSummaryMessage("Projected summary"),
        ...messages.slice(fromIndex),
      ];
      const { messages: projectedMessages } = truncateToolResultsAcrossHistory(
        rawProjected,
        COMPACTION_TOOL_RESULT_MAX_CHARS,
      );
      return estimatePromptTokens(projectedMessages, this.systemPrompt, {
        providerName: this.estimationProviderName,
        toolTokenBudget: this.toolTokenBudget,
      });
    };

    let lo = minFloor;
    let hi = userTurnStarts.length;

    // Fast path: if keeping all turns already fits, skip the search.
    if (hi > lo && projectedTokensForKeep(hi) > targetTokens) {
      // Binary search: find the largest keepTurns where projected tokens fit.
      while (lo < hi) {
        const mid = lo + Math.ceil((hi - lo) / 2);
        if (projectedTokensForKeep(mid) <= targetTokens) {
          lo = mid;
        } else {
          hi = mid - 1;
        }
      }
    } else {
      lo = hi;
    }

    const keepTurns = lo;
    const rawKeepFromIndex =
      keepTurns === 0
        ? messages.length
        : (userTurnStarts[userTurnStarts.length - keepTurns] ??
          messages.length);
    const keepFromIndex = adjustForToolPairs(messages, rawKeepFromIndex);
    return { keepFromIndex, keepTurns };
  }

  private get summaryMaxTokens(): number {
    return Math.max(
      1,
      Math.floor(this.config.maxInputTokens * this.config.summaryBudgetRatio),
    );
  }

  /**
   * Trim the serialized transcript content blocks so that the summary prompt
   * (system prompt + existing summary + transcript + scaffolding) fits within
   * the provider's input token limit, minus the output budget reserved for the
   * summary itself.
   *
   * When the transcript exceeds the budget, blocks are dropped from the
   * beginning (oldest messages first) to preserve recent context. Image blocks
   * are dropped before text blocks within each pass since they are expensive
   * and their surrounding text context already captures the conversation flow.
   */
  private capTranscriptBlocksToTokenBudget(
    blocks: ContentBlock[],
    currentSummary: string,
  ): ContentBlock[] {
    const overheadTokens =
      estimateTextTokens(SUMMARY_SYSTEM_PROMPT) +
      estimateTextTokens(currentSummary) +
      // Scaffolding text in buildSummaryContentBlocks ("Update the summary...",
      // section headers, etc.) — generous fixed estimate.
      200 +
      this.summaryMaxTokens;

    const maxTranscriptTokens = Math.max(
      0,
      this.config.maxInputTokens - overheadTokens,
    );

    const estimateBlockTokens = (b: ContentBlock): number =>
      estimateContentBlockTokens(b, { providerName: this.estimationProviderName });

    let totalTokens = 0;
    for (const block of blocks) {
      totalTokens += estimateBlockTokens(block);
    }
    const originalTotalTokens = totalTokens;
    if (totalTokens <= maxTranscriptTokens) return blocks;

    // First pass: drop images from the beginning until we fit or run out of
    // images to drop. Images are high-cost and their text context (message
    // headers, surrounding tool_use/tool_result serializations) is preserved.
    const result = [...blocks];
    for (let i = 0; i < result.length && totalTokens > maxTranscriptTokens; i++) {
      if (result[i].type === "image") {
        totalTokens -= estimateBlockTokens(result[i]);
        const stub: ContentBlock = {
          type: "text",
          text: `[image omitted from summary context]`,
        };
        totalTokens += estimateBlockTokens(stub);
        result[i] = stub;
      }
    }
    if (totalTokens <= maxTranscriptTokens) return result;

    // Second pass: drop text blocks from the beginning (oldest) until we fit.
    // If a single text block exceeds the remaining budget, truncate it rather
    // than dropping it entirely so the summarizer always has content to work with.
    let dropUntil = 0;
    let droppedTokens = 0;
    for (let i = 0; i < result.length && totalTokens > maxTranscriptTokens; i++) {
      const blockTokens = estimateBlockTokens(result[i]);
      const excess = totalTokens - maxTranscriptTokens;
      if (blockTokens > excess && result[i].type === "text") {
        // Truncate this block to shed exactly the excess tokens.
        // Subtract the cost of the "[...truncated] " prefix so the final
        // block (prefix + kept text) stays within budget.
        const truncationPrefix = "[...truncated] ";
        const prefixTokens = estimateTextTokens(truncationPrefix);
        const keepTokens = Math.max(1, blockTokens - excess - prefixTokens);
        const text = (result[i] as { type: "text"; text: string }).text;
        // Approximate: 1 token ≈ 4 characters for truncation purposes.
        const keepChars = Math.max(1, Math.floor(keepTokens * 4));
        const truncatedText = text.slice(-keepChars);
        const truncatedBlock: ContentBlock = {
          type: "text",
          text: `${truncationPrefix}${truncatedText}`,
        };
        const newBlockTokens = estimateBlockTokens(truncatedBlock);
        droppedTokens += blockTokens - newBlockTokens;
        totalTokens -= blockTokens - newBlockTokens;
        result[i] = truncatedBlock;
        dropUntil = i;
        break;
      }
      droppedTokens += blockTokens;
      totalTokens -= blockTokens;
      dropUntil = i + 1;
    }

    log.info(
      {
        originalTokens: originalTotalTokens,
        cappedTokens: maxTranscriptTokens,
        droppedTokens,
      },
      "Capped summary transcript blocks to fit provider input limit",
    );

    return [
      { type: "text", text: "[earlier messages truncated]" } as ContentBlock,
      ...result.slice(dropUntil),
    ];
  }

  private async updateSummary(
    currentSummary: string,
    transcriptBlocks: ContentBlock[],
    signal?: AbortSignal,
  ): Promise<{
    summary: string;
    inputTokens: number;
    outputTokens: number;
    model: string;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    rawResponse?: unknown;
  }> {
    const contentBlocks = buildSummaryContentBlocks(
      currentSummary,
      transcriptBlocks,
    );
    const summaryMessage: Message = { role: "user", content: contentBlocks };
    try {
      const response = await this.provider.sendMessage(
        [summaryMessage],
        undefined,
        SUMMARY_SYSTEM_PROMPT,
        {
          config: { max_tokens: this.summaryMaxTokens },
          signal,
        },
      );

      const nextSummary = extractText(response.content).trim();
      if (nextSummary.length > 0) {
        return {
          summary: this.clampSummary(nextSummary),
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          model: response.model,
          cacheCreationInputTokens:
            response.usage.cacheCreationInputTokens ?? 0,
          cacheReadInputTokens: response.usage.cacheReadInputTokens ?? 0,
          rawResponse: response.rawResponse,
        };
      }
    } catch (err) {
      log.warn({ err }, "Summary generation failed, using local fallback");
    }

    // Fallback: extract text-only transcript for local summary generation.
    const textTranscript = transcriptBlocks
      .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n\n");

    return {
      summary: fallbackSummary(currentSummary, textTranscript),
      inputTokens: 0,
      outputTokens: 0,
      model: "",
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };
  }

  private clampSummary(summary: string): string {
    // Budget in tokens → approximate char limit (4 chars ≈ 1 token).
    const maxChars = this.summaryMaxTokens * 4;
    if (summary.length <= maxChars) return summary;
    return `${safeStringSlice(summary, 0, maxChars)}...`;
  }
}

function collectUserTurnStartIndexes(messages: Message[]): number[] {
  const starts: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role !== "user") continue;
    if (getSummaryFromContextMessage(message) != null) continue;
    if (isToolResultOnly(message)) continue;
    starts.push(i);
  }
  return starts;
}

/**
 * Count messages that have DB counterparts.  Context-summary messages are
 * in-memory-only and excluded; ALL other messages (including tool-result-only
 * user messages) have a corresponding row in the DB and must be counted so
 * that `contextCompactedMessageCount` indexes the DB array correctly.
 */
function countPersistedMessages(messages: Message[]): number {
  return messages.filter((message) => {
    return getSummaryFromContextMessage(message) == null;
  }).length;
}

function isSystemNoticeBlock(block: ContentBlock): boolean {
  if (block.type !== "text") return false;
  const text = (block as { text?: string }).text ?? "";
  return (
    text.startsWith("<system_notice>") && text.endsWith("</system_notice>")
  );
}

/** A user message that contains ONLY tool_result blocks (no text or other content).
 *  System notice text blocks (retry nudges, progress checks) do not count as user content. */
function isToolResultOnly(message: Message): boolean {
  return (
    message.content.length > 0 &&
    message.content.every(
      (block) =>
        block.type === "tool_result" ||
        block.type === "web_search_tool_result" ||
        isSystemNoticeBlock(block),
    )
  );
}

/**
 * Walk the keep boundary backward to ensure tool_use/tool_result pairs are
 * never split across the compaction boundary. If the first kept message is
 * a user message containing tool_result blocks whose matching tool_use blocks
 * live in the preceding (compacted-away) assistant message, include that
 * assistant message in the kept set.
 */
function adjustForToolPairs(
  messages: Message[],
  keepFromIndex: number,
): number {
  let idx = keepFromIndex;
  while (idx > 0) {
    const msg = messages[idx];
    if (!msg || msg.role !== "user") break;

    // Collect tool_use_ids referenced by tool_results in this user message
    const referencedIds = new Set<string>();
    for (const block of msg.content) {
      if ((block.type === "tool_result" || block.type === "web_search_tool_result") && "tool_use_id" in block) {
        referencedIds.add((block as { tool_use_id: string }).tool_use_id);
      }
    }
    if (referencedIds.size === 0) break;

    // Check if the preceding assistant message contains matching tool_uses
    const prev = messages[idx - 1];
    if (!prev || prev.role !== "assistant") break;

    const hasOrphanedPair = prev.content.some(
      (block) =>
        (block.type === "tool_use" || block.type === "server_tool_use") &&
        "id" in block &&
        referencedIds.has((block as { id: string }).id),
    );
    if (!hasOrphanedPair) break;

    // Include the assistant message
    idx--;

    // The assistant message may itself be preceded by a tool_result user
    // message that pairs with an even earlier assistant — continue the check
    if (idx > 0 && messages[idx - 1]?.role === "user") {
      idx--;
    } else {
      break;
    }
  }
  return idx;
}

export function getSummaryFromContextMessage(
  message: Message | undefined,
): string | null {
  if (!message) return null;
  const text = extractText(message.content).trim();
  if (!text.startsWith(CONTEXT_SUMMARY_MARKER)) return null;
  if (INTERNAL_CONTEXT_SUMMARY_MESSAGES.has(message)) {
    return stripContextSummaryTags(text);
  }
  return null;
}

function stripContextSummaryTags(text: string): string {
  let inner = text.slice(CONTEXT_SUMMARY_MARKER.length);
  const closeIdx = inner.lastIndexOf("</context_summary>");
  if (closeIdx !== -1) {
    inner = inner.slice(0, closeIdx);
  }
  return inner.trim();
}

export function createContextSummaryMessage(summary: string): Message {
  const message: Message = {
    role: "user",
    content: [
      {
        type: "text",
        text: `${CONTEXT_SUMMARY_MARKER}\n${summary}\n</context_summary>`,
      },
    ],
  };
  INTERNAL_CONTEXT_SUMMARY_MESSAGES.add(message);
  return message;
}

/**
 * Build content blocks for the summary prompt. Returns a mix of text blocks
 * (for the scaffolding, existing summary, and serialized non-image content)
 * and image blocks (preserved from the original messages so the summarizer
 * can describe what was in them).
 */
function buildSummaryContentBlocks(
  currentSummary: string,
  transcriptBlocks: ContentBlock[],
): ContentBlock[] {
  return [
    {
      type: "text",
      text: [
        "Update the summary with new transcript data.",
        "If new information conflicts with older notes, keep the most recent and explicit detail.",
        "Keep all unresolved asks and next steps.",
        "For any images included below, describe their visual content in the summary so the information is preserved after compaction.",
        "",
        "### Existing Summary",
        currentSummary.trim().length > 0 ? currentSummary.trim() : "None.",
        "",
        "### Transcript",
      ].join("\n"),
    } as ContentBlock,
    ...transcriptBlocks,
  ];
}

/**
 * Serialize messages into a sequence of content blocks. Text-based content
 * (tool calls, tool results, thinking, etc.) is serialized into text blocks.
 * Image blocks — both top-level and nested inside tool_result contentBlocks —
 * are preserved as-is so the summarizer LLM can see them.
 */
function serializeMessagesToContentBlocks(messages: Message[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const textLines: string[] = [`Message #${i + 1} (${msg.role})`];

    for (const block of msg.content) {
      if (block.type === "image") {
        // Flush accumulated text lines before the image.
        if (textLines.length > 0) {
          blocks.push({ type: "text", text: textLines.join("\n") });
          textLines.length = 0;
        }
        blocks.push(block);
      } else if (block.type === "tool_result") { // guard:allow-tool-result-only — web_search_tool_result handled by serializeBlock via else branch
        // Extract images from tool_result contentBlocks before serializing.
        const collectedImages: ImageContent[] = [];
        textLines.push(serializeToolResultBlock(block, collectedImages));
        if (collectedImages.length > 0) {
          // Flush text, emit collected images, then continue.
          if (textLines.length > 0) {
            blocks.push({ type: "text", text: textLines.join("\n") });
            textLines.length = 0;
          }
          blocks.push(...collectedImages);
        }
      } else {
        textLines.push(serializeBlock(block));
      }
    }

    // Flush remaining text lines for this message.
    if (textLines.length > 0) {
      blocks.push({ type: "text", text: textLines.join("\n") });
    }
  }
  return blocks;
}

/**
 * Serialize images nested inside tool_result contentBlocks, returning them
 * as separate content blocks to preserve for the summarizer.
 */
function serializeToolResultBlock(
  block: Extract<ContentBlock, { type: "tool_result" }>,
  collectedImages: ImageContent[],
): string {
  if (block.contentBlocks) {
    for (const cb of block.contentBlocks) {
      if (cb.type === "image") {
        collectedImages.push(cb);
      }
    }
  }
  return `tool_result ${block.tool_use_id}${
    block.is_error ? " (error)" : ""
  }: ${clampText(block.content)}`;
}

function serializeBlock(block: ContentBlock): string {
  switch (block.type) {
    case "text":
      return `text: ${clampText(block.text)}`;
    case "tool_use":
      return `tool_use ${block.name}: ${clampText(stableJson(block.input))}`;
    case "tool_result":
      return `tool_result ${block.tool_use_id}${
        block.is_error ? " (error)" : ""
      }: ${clampText(block.content)}`;
    case "image":
      // Top-level images are handled by serializeMessagesToContentBlocks.
      // This path is only hit for images in unexpected positions.
      return `image: ${block.source.media_type}, ${
        Math.ceil(block.source.data.length / 4) * 3
      } bytes(base64)`;
    case "file": {
      const sizeBytes = Math.ceil(block.source.data.length / 4) * 3;
      const parts = [
        `file: ${block.source.filename}`,
        block.source.media_type,
        `${sizeBytes} bytes(base64)`,
      ];
      if (block.extracted_text) {
        parts.push(`text=${clampText(block.extracted_text)}`);
      }
      return parts.join(", ");
    }
    case "thinking":
      return `thinking: ${clampText(block.thinking)}`;
    case "redacted_thinking":
      return "redacted_thinking";
    case "server_tool_use":
      return `server_tool_use ${block.name}: ${clampText(stableJson(block.input))}`;
    case "web_search_tool_result":
      return `web_search_tool_result ${block.tool_use_id}`;
    default:
      return "unknown_block";
  }
}

function clampText(text: string): string {
  if (text.length <= MAX_BLOCK_PREVIEW_CHARS) return text;
  return `${safeStringSlice(text, 0, MAX_BLOCK_PREVIEW_CHARS)}... [truncated ${
    text.length - MAX_BLOCK_PREVIEW_CHARS
  } chars]`;
}

function fallbackSummary(currentSummary: string, chunk: string): string {
  const lines = chunk
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const recentLines = lines.slice(-120).join("\n");
  const merged = [
    currentSummary.trim(),
    "## Recent Progress",
    recentLines.length > 0 ? recentLines : "No new details.",
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");
  if (merged.length <= MAX_FALLBACK_SUMMARY_CHARS) return merged;
  return merged.slice(merged.length - MAX_FALLBACK_SUMMARY_CHARS);
}

function extractText(content: ContentBlock[]): string {
  return content
    .filter(
      (block): block is Extract<ContentBlock, { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join("\n");
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

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
// plugin pipeline, applyCompactionResult, routes/playground/force-compact).
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
}

export interface ShouldCompactResult {
  needed: boolean;
  estimatedTokens: number;
}

export interface ContextWindowCompactOptions {
  lastCompactedAt?: number;
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
   * Legacy fields retained for backwards compatibility with existing
   * callers. The new assistant-driven compactor does not consume them —
   * the model decides where to cut and what to keep — but accepting them
   * here lets callers keep their existing call sites unchanged.
   */
  minKeepRecentUserTurns?: number;
  conversationOriginChannel?: string;
  targetInputTokensOverride?: number;
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

    const args: CompactionRunArgs = {
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
      nonPersistedPrefixCount: this.nonPersistedPrefixCount,
    };

    const result = await runAssistantDrivenCompaction(args);

    if (!result.compacted) return result;

    // Recompute the post-compaction token estimate now that the message
    // array has been rebuilt. The compactor returns a conservative
    // placeholder; the agent loop wants the real number for its next
    // budget decision.
    let estimatedInputTokens = result.estimatedInputTokens;
    try {
      estimatedInputTokens = estimatePromptTokens(
        result.messages,
        this.systemPrompt,
        {
          providerName: this.estimationProviderName,
          toolTokenBudget: this.toolTokenBudget,
        },
      );
    } catch (err) {
      log.warn({ err }, "Post-compaction token estimate failed");
    }

    // Consume any non-persisted prefix messages that were compacted away
    // and clear the injected-summary flag.
    const compactedAway = Math.min(
      this.nonPersistedPrefixCount,
      result.compactedMessages,
    );
    this.nonPersistedPrefixCount = Math.max(
      0,
      this.nonPersistedPrefixCount - compactedAway,
    );
    this.summaryIsInjected = false;

    return { ...result, estimatedInputTokens };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

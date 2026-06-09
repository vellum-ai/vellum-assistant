/**
 * Deterministic context overflow reducer.
 *
 * Given a message history that exceeds the provider's context limit, this
 * module applies a sequence of monotonically more aggressive reduction tiers
 * until the estimated token count fits within a target budget.
 *
 * Each tier is idempotent: re-applying the same tier to already-reduced
 * messages is a no-op. Tiers are ordered so that less destructive
 * transformations are tried first.
 *
 * Rung progression:
 *   0. Emergency summarize-around-last-tool-pair (preserves the most recent
 *      tool call/result while aggressively compressing earlier history)
 *   1. Forced full-history compaction (emergency keep-boundary options)
 *   2. Aggressive tool-result text truncation across retained history
 *   3. Media/file payload stubbing (replace images/files with text stubs)
 *   4. Runtime injection downgrade to minimal mode
 *   terminal. Auto-compress the latest turn (policy-gated by the caller)
 *
 * Rungs 1–4 are the "middle tiers" and are bounded by `maxMiddleTierAttempts`.
 * The emergency rung always runs first; the auto-compress rung runs last and
 * only when the caller permits it. The caller invokes the reducer repeatedly,
 * re-running the agent loop after each rung, until either the context fits or
 * `state.exhausted` is true.
 */

import type { ContextWindowConfig } from "../../../config/types.js";
import {
  estimateContentBlockTokens,
  estimatePromptTokens,
} from "../../../context/token-estimator.js";
import { truncateToolResultsAcrossHistory } from "../../../context/tool-result-truncation.js";
import {
  countMediaBlocks,
  estimateUnconditionalStubTokens,
  stripMediaPayloadsForRetry,
} from "../../../daemon/conversation-media-retry.js";
import type { InjectionMode } from "../../../daemon/conversation-runtime-assembly.js";
import type { Message } from "../../../providers/types.js";
import type { TrustClass } from "../../../runtime/actor-trust-resolver.js";
import { getLogger } from "../../../util/logger.js";
import { defaultCompact, defaultEmergencyCompact } from "./compact.js";
import type {
  ContextWindowCompactOptions,
  ContextWindowResult,
} from "./window-manager.js";

const log = getLogger("context-overflow-reducer");

/**
 * Identifies which reduction tier was applied in a given step.
 */
export type ReducerTier =
  | "emergency_compaction"
  | "forced_compaction"
  | "tool_result_truncation"
  | "media_stubbing"
  | "injection_downgrade"
  | "auto_compress_latest_turn";

/**
 * The "middle tiers" — the rungs bounded by `maxMiddleTierAttempts`. The
 * emergency and auto-compress rungs are intentionally excluded so they remain
 * reachable regardless of how small the middle-tier budget is.
 */
const MIDDLE_TIERS: readonly ReducerTier[] = [
  "forced_compaction",
  "tool_result_truncation",
  "media_stubbing",
  "injection_downgrade",
];

/**
 * Tracks the cumulative state of the reducer across successive calls.
 * Callers pass this back in on each iteration so the reducer knows
 * which tiers have already been applied.
 */
export interface ReducerState {
  /** The last tier that was successfully applied. */
  appliedTiers: ReducerTier[];
  /** The injection mode to use for the next provider call. */
  injectionMode: InjectionMode;
  /** The compaction options used during forced compaction, if any. */
  compactionOptions?: ContextWindowCompactOptions;
  /** The max chars used for tool-result truncation, if applied. */
  toolResultMaxChars?: number;
  /** Whether the reducer has exhausted all tiers. */
  exhausted: boolean;
}

/**
 * The result of a single reducer step.
 */
export interface ReducerStepResult {
  /** The reduced messages (may be identical to input if tier was a no-op). */
  messages: Message[];
  /** The tier that was applied in this step. */
  tier: ReducerTier;
  /** Updated state to pass into the next call. */
  state: ReducerState;
  /** Estimated prompt tokens after this step's reduction. */
  estimatedTokens: number;
  /**
   * If this step used forced compaction, the compaction result is attached
   * so the caller can persist summary text and compacted message counts.
   */
  compactionResult?: ContextWindowResult;
}

/**
 * Configuration for the reducer.
 */
export interface ReducerConfig {
  /** Provider name for token estimation. */
  providerName: string;
  /** The system prompt (needed for accurate token estimation). */
  systemPrompt: string;
  /** The context window config from the assistant config. */
  contextWindow: ContextWindowConfig;
  /** Target token budget — the reducer tries to get below this. */
  targetTokens: number;
  /** Pre-computed tool token budget to include in estimations. */
  toolTokenBudget?: number;
  /**
   * Conversation whose {@link ContextWindowManager} the compaction rungs
   * resolve from the compaction store to run the summary call.
   */
  conversationId: string;
  /** Per-conversation inference-profile override for the summary call. */
  overrideProfile?: string | null;
  /** Trust class of the actor whose turn triggered overflow recovery. */
  actorTrustClass?: TrustClass;
  /**
   * The provider-reported estimate at the overflow that triggered recovery.
   * Sizes the emergency summarize-around-last-tool-pair cut.
   */
  previousEstimatedInputTokens: number;
  /**
   * Maximum number of middle-tier reductions (forced compaction, tool-result
   * truncation, media stubbing, injection downgrade) to apply before
   * escalating to the terminal auto-compress rung. The emergency and
   * auto-compress rungs are not counted against this budget.
   */
  maxMiddleTierAttempts: number;
  /**
   * Whether the terminal auto-compress-latest-turn rung is permitted. The
   * caller resolves this from the overflow policy; when false, the ladder ends
   * once the middle tiers are exhausted.
   */
  allowAutoCompressLatestTurn: boolean;
}

// Aggressive truncation cap for tool results during overflow recovery.
// Much tighter than the normal per-result budget.
const OVERFLOW_TOOL_RESULT_MAX_CHARS = 4_000;

/**
 * Determine the next reduction step to apply.
 *
 * The caller invokes this repeatedly, feeding the returned state back in,
 * until either the estimated tokens are within budget or `state.exhausted`
 * is true.
 */
export async function reduceContextOverflow(
  messages: Message[],
  config: ReducerConfig,
  state: ReducerState | undefined,
  signal?: AbortSignal,
): Promise<ReducerStepResult> {
  const applied = state?.appliedTiers ?? [];
  const step = await selectNextRung(messages, config, state, applied, signal);

  // Exhaustion is decided centrally from the rungs applied so far so the last
  // rung that actually runs sets `exhausted`, avoiding a wasted no-op rerun.
  step.state.exhausted = isLadderExhausted(step.state.appliedTiers, config);
  return step;
}

async function selectNextRung(
  messages: Message[],
  config: ReducerConfig,
  state: ReducerState | undefined,
  applied: ReducerTier[],
  signal?: AbortSignal,
): Promise<ReducerStepResult> {
  // Rung 0: emergency summarize-around-last-tool-pair (uncounted, runs first).
  if (!applied.includes("emergency_compaction")) {
    return applyEmergencyCompaction(messages, config, applied, signal);
  }

  // Middle tiers (rungs 1–4), bounded by the configured attempt budget.
  const middleApplied = applied.filter((t) => MIDDLE_TIERS.includes(t)).length;
  if (
    middleApplied < config.maxMiddleTierAttempts &&
    hasUnappliedMiddleTier(applied)
  ) {
    if (!applied.includes("forced_compaction")) {
      return applyForcedCompaction(messages, config, applied, signal);
    }
    if (!applied.includes("tool_result_truncation")) {
      return applyToolResultTruncation(messages, config, applied, state);
    }
    if (!applied.includes("media_stubbing")) {
      return applyMediaStubbing(messages, config, applied, state);
    }
    return applyInjectionDowngrade(messages, config, applied, state);
  }

  // Terminal rung: auto-compress the latest turn (uncounted, policy-gated).
  if (
    config.allowAutoCompressLatestTurn &&
    !applied.includes("auto_compress_latest_turn")
  ) {
    return applyAutoCompressLatestTurn(
      messages,
      config,
      applied,
      state,
      signal,
    );
  }

  // No rung left to apply — return a no-op step. `reduceContextOverflow`
  // marks it exhausted via `isLadderExhausted`.
  const estimatedTokens = estimatePromptTokens(messages, config.systemPrompt, {
    providerName: config.providerName,
    toolTokenBudget: config.toolTokenBudget,
  });
  return {
    messages,
    tier: applied[applied.length - 1] ?? "forced_compaction",
    state: {
      appliedTiers: [...applied],
      injectionMode: state?.injectionMode ?? "minimal",
      toolResultMaxChars: state?.toolResultMaxChars,
      compactionOptions: state?.compactionOptions,
      exhausted: true,
    },
    estimatedTokens,
  };
}

/** Whether any middle tier remains unapplied. */
function hasUnappliedMiddleTier(applied: ReducerTier[]): boolean {
  return MIDDLE_TIERS.some((tier) => !applied.includes(tier));
}

/**
 * Decide whether the ladder has nothing more to try after the given rungs.
 * The terminal auto-compress rung is the last; before it, the middle tiers
 * are exhausted once the attempt budget is spent or every middle tier ran.
 */
function isLadderExhausted(
  applied: ReducerTier[],
  config: ReducerConfig,
): boolean {
  if (applied.includes("auto_compress_latest_turn")) {
    return true;
  }
  const middleApplied = applied.filter((t) => MIDDLE_TIERS.includes(t)).length;
  const middleExhausted =
    middleApplied >= config.maxMiddleTierAttempts ||
    !hasUnappliedMiddleTier(applied);
  if (!middleExhausted) {
    return false;
  }
  // Middle tiers are done — the ladder continues only if the terminal
  // auto-compress rung is permitted and has not run yet.
  return !config.allowAutoCompressLatestTurn;
}

async function applyEmergencyCompaction(
  messages: Message[],
  config: ReducerConfig,
  applied: ReducerTier[],
  signal?: AbortSignal,
): Promise<ReducerStepResult> {
  let result: ContextWindowResult | null = null;
  try {
    result = await defaultEmergencyCompact({
      conversationId: config.conversationId,
      messages,
      previousEstimatedInputTokens: config.previousEstimatedInputTokens,
      overrideProfile: config.overrideProfile ?? null,
      signal,
    });
  } catch (err) {
    // No tool pair to split on, an unparseable summary, or a provider error.
    // Fall through to forced compaction below rather than failing recovery.
    log.warn(
      { err },
      "Emergency mid-turn compaction failed; falling through to forced compaction",
    );
  }

  if (result?.compacted) {
    return {
      messages: result.messages,
      tier: "emergency_compaction",
      state: {
        appliedTiers: [...applied, "emergency_compaction"],
        injectionMode: "full",
        exhausted: false,
      },
      estimatedTokens: result.estimatedInputTokens,
      compactionResult: result,
    };
  }

  // Emergency compaction produced no reduction; continue straight to forced
  // compaction in the same step so the caller does not waste a provider rerun
  // on unchanged messages.
  return applyForcedCompaction(
    messages,
    config,
    [...applied, "emergency_compaction"],
    signal,
  );
}

async function applyForcedCompaction(
  messages: Message[],
  config: ReducerConfig,
  applied: ReducerTier[],
  signal?: AbortSignal,
): Promise<ReducerStepResult> {
  const compactionOptions: ContextWindowCompactOptions = {
    force: true,
    minKeepRecentUserTurns: 0,
  };

  const result = await defaultCompact({
    conversationId: config.conversationId,
    messages,
    signal,
    ...compactionOptions,
    overrideProfile: config.overrideProfile ?? null,
    actorTrustClass: config.actorTrustClass,
  });
  const nextMessages = result.compacted ? result.messages : messages;
  const estimatedTokens = result.compacted
    ? result.estimatedInputTokens
    : estimatePromptTokens(messages, config.systemPrompt, {
        providerName: config.providerName,
        toolTokenBudget: config.toolTokenBudget,
      });

  const nextApplied: ReducerTier[] = [...applied, "forced_compaction"];
  return {
    messages: nextMessages,
    tier: "forced_compaction",
    state: {
      appliedTiers: nextApplied,
      injectionMode: "full",
      compactionOptions,
      exhausted: false,
    },
    estimatedTokens,
    compactionResult: result,
  };
}

function applyToolResultTruncation(
  messages: Message[],
  config: ReducerConfig,
  applied: ReducerTier[],
  prevState: ReducerState | undefined,
): ReducerStepResult {
  const { messages: truncated, truncatedCount } =
    truncateToolResultsAcrossHistory(messages, OVERFLOW_TOOL_RESULT_MAX_CHARS);

  const nextMessages = truncatedCount > 0 ? truncated : messages;
  const estimatedTokens = estimatePromptTokens(
    nextMessages,
    config.systemPrompt,
    {
      providerName: config.providerName,
      toolTokenBudget: config.toolTokenBudget,
    },
  );

  const nextApplied: ReducerTier[] = [...applied, "tool_result_truncation"];
  return {
    messages: nextMessages,
    tier: "tool_result_truncation",
    state: {
      appliedTiers: nextApplied,
      injectionMode: prevState?.injectionMode ?? "full",
      toolResultMaxChars: OVERFLOW_TOOL_RESULT_MAX_CHARS,
      compactionOptions: prevState?.compactionOptions,
      exhausted: false,
    },
    estimatedTokens,
  };
}

function applyMediaStubbing(
  messages: Message[],
  config: ReducerConfig,
  applied: ReducerTier[],
  prevState: ReducerState | undefined,
): ReducerStepResult {
  const mediaCount = countMediaBlocks(messages);
  let nextMessages = messages;

  if (mediaCount > 0) {
    // Compute the token budget available for media content.
    const totalTokens = estimatePromptTokens(messages, config.systemPrompt, {
      providerName: config.providerName,
      toolTokenBudget: config.toolTokenBudget,
    });

    // Sum tokens for all image and file blocks (top-level and nested in tool_result).
    let mediaTokens = 0;
    for (const msg of messages) {
      for (const block of msg.content) {
        if (block.type === "image" || block.type === "file") {
          mediaTokens += estimateContentBlockTokens(block, {
            providerName: config.providerName,
          });
        } else if (block.type === "tool_result" && block.contentBlocks) {
          for (const cb of block.contentBlocks) {
            if (cb.type === "image" || cb.type === "file") {
              mediaTokens += estimateContentBlockTokens(cb, {
                providerName: config.providerName,
              });
            }
          }
        }
      }
    }

    const nonMediaTokens = totalTokens - mediaTokens;

    // Account for the token cost of text stubs that replace unconditionally
    // stubbed media (non-latest-user images/files, tool_result-nested media).
    // Without this adjustment the budget is systematically over-allocated.
    const estimatedStubTokens = estimateUnconditionalStubTokens(messages, {
      providerName: config.providerName,
    });
    const adjustedNonMediaTokens = nonMediaTokens + estimatedStubTokens;
    const mediaTokenBudget = Math.max(
      0,
      config.targetTokens - adjustedNonMediaTokens,
    );

    const stripped = stripMediaPayloadsForRetry(messages, {
      mediaTokenBudget,
      providerName: config.providerName,
    });
    if (stripped.modified) {
      nextMessages = stripped.messages;
    }
  }

  const estimatedTokens = estimatePromptTokens(
    nextMessages,
    config.systemPrompt,
    {
      providerName: config.providerName,
      toolTokenBudget: config.toolTokenBudget,
    },
  );

  const nextApplied: ReducerTier[] = [...applied, "media_stubbing"];
  return {
    messages: nextMessages,
    tier: "media_stubbing",
    state: {
      appliedTiers: nextApplied,
      injectionMode: prevState?.injectionMode ?? "full",
      toolResultMaxChars: prevState?.toolResultMaxChars,
      compactionOptions: prevState?.compactionOptions,
      exhausted: false,
    },
    estimatedTokens,
  };
}

function applyInjectionDowngrade(
  messages: Message[],
  config: ReducerConfig,
  applied: ReducerTier[],
  prevState: ReducerState | undefined,
): ReducerStepResult {
  // The injection downgrade itself does not modify messages — it signals
  // to the caller that the next provider call should use minimal injection
  // mode, which the caller applies via applyRuntimeInjections().
  const estimatedTokens = estimatePromptTokens(messages, config.systemPrompt, {
    providerName: config.providerName,
    toolTokenBudget: config.toolTokenBudget,
  });

  const nextApplied: ReducerTier[] = [...applied, "injection_downgrade"];
  return {
    messages,
    tier: "injection_downgrade",
    state: {
      appliedTiers: nextApplied,
      injectionMode: "minimal",
      toolResultMaxChars: prevState?.toolResultMaxChars,
      compactionOptions: prevState?.compactionOptions,
      exhausted: false,
    },
    estimatedTokens,
  };
}

async function applyAutoCompressLatestTurn(
  messages: Message[],
  config: ReducerConfig,
  applied: ReducerTier[],
  prevState: ReducerState | undefined,
  signal?: AbortSignal,
): Promise<ReducerStepResult> {
  // Force-compress the latest turn as a last resort. Shares the forced
  // compaction options, but runs after the middle tiers have been spent.
  const compactionOptions: ContextWindowCompactOptions = {
    force: true,
    minKeepRecentUserTurns: 0,
  };

  const result = await defaultCompact({
    conversationId: config.conversationId,
    messages,
    signal,
    ...compactionOptions,
    overrideProfile: config.overrideProfile ?? null,
    actorTrustClass: config.actorTrustClass,
  });
  const nextMessages = result.compacted ? result.messages : messages;
  const estimatedTokens = result.compacted
    ? result.estimatedInputTokens
    : estimatePromptTokens(nextMessages, config.systemPrompt, {
        providerName: config.providerName,
        toolTokenBudget: config.toolTokenBudget,
      });

  const nextApplied: ReducerTier[] = [...applied, "auto_compress_latest_turn"];
  return {
    messages: nextMessages,
    tier: "auto_compress_latest_turn",
    state: {
      appliedTiers: nextApplied,
      injectionMode: prevState?.injectionMode ?? "full",
      toolResultMaxChars: prevState?.toolResultMaxChars,
      compactionOptions,
      exhausted: false,
    },
    estimatedTokens,
    compactionResult: result,
  };
}

/**
 * Create the initial (empty) reducer state.
 */
export function createInitialReducerState(): ReducerState {
  return {
    appliedTiers: [],
    injectionMode: "full",
    exhausted: false,
  };
}

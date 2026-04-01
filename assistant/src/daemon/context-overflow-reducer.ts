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
 * Tier progression:
 *   1. Forced compaction (emergency keep-boundary options)
 *   2. Aggressive tool-result text truncation across retained history
 *   3. Media/file payload stubbing (replace images/files with text stubs)
 *   4. Runtime injection downgrade to minimal mode
 */

import type { ContextWindowConfig } from "../config/types.js";
import {
  estimateContentBlockTokens,
  estimatePromptTokens,
} from "../context/token-estimator.js";
import { truncateToolResultsAcrossHistory } from "../context/tool-result-truncation.js";
import type {
  ContextWindowCompactOptions,
  ContextWindowResult,
} from "../context/window-manager.js";
import type { Message } from "../providers/types.js";
import {
  countMediaBlocks,
  stripMediaPayloadsForRetry,
} from "./conversation-media-retry.js";
import type { InjectionMode } from "./conversation-runtime-assembly.js";

/**
 * Identifies which reduction tier was applied in a given step.
 */
export type ReducerTier =
  | "forced_compaction"
  | "tool_result_truncation"
  | "media_stubbing"
  | "injection_downgrade";

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
}

/**
 * Compaction callback — the reducer does not own the ContextWindowManager
 * instance, so the caller provides a function that performs compaction.
 */
export type CompactFn = (
  messages: Message[],
  signal: AbortSignal | undefined,
  options: ContextWindowCompactOptions,
) => Promise<ContextWindowResult>;

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
  compactFn: CompactFn,
  signal?: AbortSignal,
): Promise<ReducerStepResult> {
  const applied = state?.appliedTiers ?? [];

  // Tier 1: forced compaction
  if (!applied.includes("forced_compaction")) {
    return applyForcedCompaction(messages, config, applied, compactFn, signal);
  }

  // Tier 2: aggressive tool-result truncation
  if (!applied.includes("tool_result_truncation")) {
    return applyToolResultTruncation(messages, config, applied, state);
  }

  // Tier 3: media/file payload stubbing
  if (!applied.includes("media_stubbing")) {
    return applyMediaStubbing(messages, config, applied, state);
  }

  // Tier 4: injection downgrade
  if (!applied.includes("injection_downgrade")) {
    return applyInjectionDowngrade(messages, config, applied, state);
  }

  // All tiers exhausted
  const estimatedTokens = estimatePromptTokens(messages, config.systemPrompt, {
    providerName: config.providerName,
    toolTokenBudget: config.toolTokenBudget,
  });
  return {
    messages,
    tier: "injection_downgrade",
    state: {
      appliedTiers: [...applied],
      injectionMode: state?.injectionMode ?? "minimal",
      exhausted: true,
    },
    estimatedTokens,
  };
}

async function applyForcedCompaction(
  messages: Message[],
  config: ReducerConfig,
  applied: ReducerTier[],
  compactFn: CompactFn,
  signal?: AbortSignal,
): Promise<ReducerStepResult> {
  const compactionOptions: ContextWindowCompactOptions = {
    force: true,
    minKeepRecentUserTurns: 0,
    targetInputTokensOverride: config.targetTokens,
  };

  const result = await compactFn(messages, signal, compactionOptions);
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
    const mediaTokenBudget = Math.max(0, config.targetTokens - nonMediaTokens);

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
      exhausted: true,
    },
    estimatedTokens,
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

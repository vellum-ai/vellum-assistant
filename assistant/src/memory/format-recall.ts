import { estimateTextTokens } from "../context/token-estimator.js";
import { buildInjectedText } from "./search/formatting.js";
import { markItemUsage, trimToTokenBudget } from "./search/ranking.js";
import type { Candidate } from "./search/types.js";

export interface FormatRecallTextOptions {
  /** Injection format: 'markdown' or 'structured_v1'. */
  format: string;
  /** Maximum token budget for the formatted output. */
  maxTokens: number;
}

export interface FormatRecallTextResult {
  /** The formatted text ready for injection. */
  text: string;
  /** Candidates that fit within the token budget. */
  selected: Candidate[];
  /** Token count of the final injected text. */
  tokenCount: number;
}

/**
 * Format scored recall candidates into injectable text.
 *
 * Trims candidates to the token budget, groups by section with temporal
 * grounding, applies "Lost in the Middle" ordering, and marks item usage.
 *
 * Extracted from `formatRecallResult()` in `retriever.ts` so both the
 * auto-injection path and the on-demand memory_recall tool can reuse it.
 */
export function formatRecallText(
  candidates: Candidate[],
  opts: FormatRecallTextOptions,
): FormatRecallTextResult {
  const { format, maxTokens } = opts;

  const selected = trimToTokenBudget(candidates, maxTokens, format);
  markItemUsage(selected);

  const text = buildInjectedText(selected, format);

  return {
    text,
    selected,
    tokenCount: estimateTextTokens(text),
  };
}

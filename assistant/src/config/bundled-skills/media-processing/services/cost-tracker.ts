/**
 * Tracks token usage and estimated costs across video segment processing.
 *
 * Uses Gemini 2.5 Flash pricing for cost estimation:
 *   - Input:  $0.15 per 1M tokens (for context <= 200k tokens)
 *   - Output: $0.60 per 1M tokens (for context <= 200k tokens)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SegmentCostEntry {
  segmentId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedUSD: number;
}

export interface CostSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalEstimatedUSD: number;
  segmentCount: number;
  entries: ReadonlyArray<SegmentCostEntry>;
}

// ---------------------------------------------------------------------------
// Pricing (per token)
// ---------------------------------------------------------------------------

/** Gemini 2.5 Flash: $0.15 / 1M input tokens (<=200k context) */
const INPUT_COST_PER_TOKEN = 0.15 / 1_000_000;

/** Gemini 2.5 Flash: $0.60 / 1M output tokens (<=200k context) */
const OUTPUT_COST_PER_TOKEN = 0.60 / 1_000_000;

// ---------------------------------------------------------------------------
// CostTracker
// ---------------------------------------------------------------------------

export class CostTracker {
  private entries: SegmentCostEntry[] = [];

  /**
   * Record token usage for a processed segment. Automatically computes
   * estimated cost using Gemini 2.5 Flash pricing.
   */
  record(params: {
    segmentId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
  }): SegmentCostEntry {
    const estimatedUSD =
      params.inputTokens * INPUT_COST_PER_TOKEN +
      params.outputTokens * OUTPUT_COST_PER_TOKEN;

    const entry: SegmentCostEntry = {
      segmentId: params.segmentId,
      model: params.model,
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      estimatedUSD,
    };

    this.entries.push(entry);
    return entry;
  }

  /**
   * Return aggregate totals and the full list of per-segment entries.
   */
  getSummary(): CostSummary {
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalEstimatedUSD = 0;

    for (const e of this.entries) {
      totalInputTokens += e.inputTokens;
      totalOutputTokens += e.outputTokens;
      totalEstimatedUSD += e.estimatedUSD;
    }

    return {
      totalInputTokens,
      totalOutputTokens,
      totalEstimatedUSD,
      segmentCount: this.entries.length,
      entries: this.entries,
    };
  }
}

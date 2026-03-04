/**
 * Tracks token usage and estimated costs across video segment processing.
 *
 * Cost estimation uses the shared pricing resolver from `assistant/src/util/pricing.ts`,
 * which maintains a multi-provider pricing catalog including Gemini models.
 */

import { resolvePricing } from "../../../../util/pricing.js";

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
// CostTracker
// ---------------------------------------------------------------------------

export class CostTracker {
  private entries: SegmentCostEntry[] = [];

  constructor(private readonly provider: string = "gemini") {}

  /**
   * Record token usage for a processed segment. Computes estimated cost
   * via the shared pricing resolver.
   */
  record(params: {
    segmentId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
  }): SegmentCostEntry {
    const result = resolvePricing(
      this.provider,
      params.model,
      params.inputTokens,
      params.outputTokens,
    );
    const estimatedUSD = result.estimatedCostUsd ?? 0;

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
      entries: [...this.entries],
    };
  }
}

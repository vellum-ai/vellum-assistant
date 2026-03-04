/**
 * Media diagnostics tool.
 *
 * Surfaces processing stats, per-stage timing, failure reasons,
 * and cost estimation for a media asset.
 * All metrics are generic media-processing infrastructure.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  getKeyframesForAsset,
  getMediaAssetById,
  getProcessingStagesForAsset,
  type ProcessingStage,
} from "../../../../memory/media-store.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import type { PreprocessManifest } from "../services/preprocess.js";
import type { ReduceCostData } from "../services/reduce.js";
// ---------------------------------------------------------------------------
// Cost estimation constants (Gemini 2.5 Flash pricing)
// ---------------------------------------------------------------------------

/** Estimated cost per segment Map call (Gemini 2.5 Flash with ~10 frames). */
const ESTIMATED_COST_PER_SEGMENT_USD = 0.001;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StageDiagnostic {
  stage: string;
  status: string;
  progress: number;
  durationMs: number | null;
  lastError: string | null;
}

interface DiagnosticReport {
  assetId: string;
  assetTitle: string;
  assetStatus: string;
  mediaType: string;
  durationSeconds: number | null;
  processingStats: {
    totalKeyframes: number;
  };
  stages: StageDiagnostic[];
  costEstimate: {
    mapPhase: {
      keyframeCount: number;
      estimatedSegments: number;
      estimatedCostPerSegment: number;
      estimatedMapCost: number;
    };
    reduceCost: ReduceCostData | null;
    estimatedTotalCost: number;
    currency: string;
    note: string;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeStageDuration(stage: ProcessingStage): number | null {
  if (stage.startedAt == null) return null;
  if (stage.completedAt != null) return stage.completedAt - stage.startedAt;
  // Only use Date.now() as a fallback for currently running stages
  if (stage.status === "running") return Date.now() - stage.startedAt;
  // For failed/pending stages without completedAt, duration is unknown
  return null;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const assetId = input.asset_id as string | undefined;
  if (!assetId) {
    return { content: "asset_id is required.", isError: true };
  }

  const asset = getMediaAssetById(assetId);
  if (!asset) {
    return { content: `Media asset not found: ${assetId}`, isError: true };
  }

  // Gather processing stats
  const keyframes = getKeyframesForAsset(assetId);

  // Per-stage diagnostics (new pipeline: preprocess, map, reduce)
  const stages = getProcessingStagesForAsset(assetId);
  const stageDiagnostics: StageDiagnostic[] = stages.map((s) => ({
    stage: s.stage,
    status: s.status,
    progress: s.progress,
    durationMs: computeStageDuration(s),
    lastError: s.lastError,
  }));

  // Cost estimation: Gemini 2.5 Flash is ~$0.001 per segment (~10 frames each)
  const keyframeCount = keyframes.length;

  // Prefer actual segment count from preprocess manifest when available
  let estimatedSegments: number;
  const manifestPath = join(
    dirname(asset.filePath),
    "pipeline",
    asset.id,
    "manifest.json",
  );
  try {
    const raw = await readFile(manifestPath, "utf-8");
    const manifest: PreprocessManifest = JSON.parse(raw);
    estimatedSegments = manifest.segments.length;
  } catch {
    // Manifest doesn't exist yet (preprocess hasn't run) — fall back to estimation
    estimatedSegments = Math.ceil(keyframeCount / 10);
  }

  const estimatedMapCost = estimatedSegments * ESTIMATED_COST_PER_SEGMENT_USD;

  // Load reduce cost data if available
  const reduceCostPath = join(
    dirname(asset.filePath),
    "pipeline",
    asset.id,
    "reduce-cost.json",
  );
  let reduceCost: ReduceCostData | null = null;
  try {
    const raw = await readFile(reduceCostPath, "utf-8");
    reduceCost = JSON.parse(raw) as ReduceCostData;
  } catch {
    // No reduce cost data yet
  }

  // Combine map + reduce costs for the total estimate
  // Reduce cost is token-based; use a rough estimate of $3/M input + $15/M output (Claude Sonnet-class)
  const reduceEstimatedCost = reduceCost
    ? (reduceCost.totalInputTokens * 3 + reduceCost.totalOutputTokens * 15) /
      1_000_000
    : 0;
  const estimatedTotalCost = estimatedMapCost + reduceEstimatedCost;

  const report: DiagnosticReport = {
    assetId: asset.id,
    assetTitle: asset.title,
    assetStatus: asset.status,
    mediaType: asset.mediaType,
    durationSeconds: asset.durationSeconds,
    processingStats: {
      totalKeyframes: keyframeCount,
    },
    stages: stageDiagnostics,
    costEstimate: {
      mapPhase: {
        keyframeCount,
        estimatedSegments,
        estimatedCostPerSegment: ESTIMATED_COST_PER_SEGMENT_USD,
        estimatedMapCost: Math.round(estimatedMapCost * 1000) / 1000,
      },
      reduceCost,
      estimatedTotalCost: Math.round(estimatedTotalCost * 1000000) / 1000000,
      currency: "USD",
      note: "Map: Gemini 2.5 Flash per segment. Reduce: Claude token-based ($3/M input, $15/M output).",
    },
  };

  return {
    content: JSON.stringify(report, null, 2),
    isError: false,
  };
}

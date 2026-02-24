/**
 * Media diagnostics tool.
 *
 * Surfaces processing stats, per-stage timing, failure reasons,
 * and cost estimation for a media asset.
 * All metrics are generic media-processing infrastructure.
 */

import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import {
  getMediaAssetById,
  getProcessingStagesForAsset,
  getKeyframesForAsset,
  type ProcessingStage,
} from '../../../../memory/media-store.js';
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
    keyframeCount: number;
    estimatedSegments: number;
    estimatedCostPerSegment: number;
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
  if (stage.status === 'running') return Date.now() - stage.startedAt;
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
    return { content: 'asset_id is required.', isError: true };
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
  const estimatedSegments = Math.ceil(keyframeCount / 10);
  const estimatedTotalCost = estimatedSegments * ESTIMATED_COST_PER_SEGMENT_USD;

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
      keyframeCount,
      estimatedSegments,
      estimatedCostPerSegment: ESTIMATED_COST_PER_SEGMENT_USD,
      estimatedTotalCost: Math.round(estimatedTotalCost * 1000) / 1000,
      currency: 'USD',
      note: 'Gemini 2.5 Flash for Map phase; Claude for Reduce phase (additional cost).',
    },
  };

  return {
    content: JSON.stringify(report, null, 2),
    isError: false,
  };
}

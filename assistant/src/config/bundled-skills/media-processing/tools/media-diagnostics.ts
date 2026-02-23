/**
 * Media diagnostics tool.
 *
 * Surfaces processing stats, per-stage timing, failure reasons,
 * cost estimation, and feedback summary for a media asset.
 * All metrics are generic media-processing infrastructure.
 */

import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import {
  getMediaAssetById,
  getProcessingStagesForAsset,
  getKeyframesForAsset,
  getVisionOutputsForAsset,
  getTimelineForAsset,
  getEventsForAsset,
  type ProcessingStage,
} from '../../../../memory/media-store.js';
import { aggregateFeedback } from '../services/feedback-aggregation.js';

// ---------------------------------------------------------------------------
// Cost estimation constants
// ---------------------------------------------------------------------------

/** Estimated cost per vision API call (one keyframe analysis). */
const ESTIMATED_COST_PER_FRAME_USD = 0.003;

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
    totalVisionOutputs: number;
    totalTimelineSegments: number;
    totalEventsDetected: number;
  };
  stages: StageDiagnostic[];
  costEstimate: {
    keyframeCount: number;
    estimatedCostPerFrame: number;
    estimatedTotalCost: number;
    currency: string;
  };
  feedbackSummary: {
    totalFeedbackEntries: number;
    statsByEventType: Array<{
      eventType: string;
      totalEvents: number;
      correct: number;
      incorrect: number;
      boundaryEdit: number;
      missed: number;
      precision: number | null;
      recall: number | null;
    }>;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeStageDuration(stage: ProcessingStage): number | null {
  if (stage.startedAt == null) return null;
  const end = stage.completedAt ?? Date.now();
  return end - stage.startedAt;
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
  const visionOutputs = getVisionOutputsForAsset(assetId);
  const timelineSegments = getTimelineForAsset(assetId);
  const events = getEventsForAsset(assetId);

  // Per-stage diagnostics
  const stages = getProcessingStagesForAsset(assetId);
  const stageDiagnostics: StageDiagnostic[] = stages.map((s) => ({
    stage: s.stage,
    status: s.status,
    progress: s.progress,
    durationMs: computeStageDuration(s),
    lastError: s.lastError,
  }));

  // Cost estimation based on keyframe count
  const keyframeCount = keyframes.length;
  const estimatedTotalCost = keyframeCount * ESTIMATED_COST_PER_FRAME_USD;

  // Feedback summary
  const feedbackResult = aggregateFeedback(assetId);

  const report: DiagnosticReport = {
    assetId: asset.id,
    assetTitle: asset.title,
    assetStatus: asset.status,
    mediaType: asset.mediaType,
    durationSeconds: asset.durationSeconds,
    processingStats: {
      totalKeyframes: keyframeCount,
      totalVisionOutputs: visionOutputs.length,
      totalTimelineSegments: timelineSegments.length,
      totalEventsDetected: events.length,
    },
    stages: stageDiagnostics,
    costEstimate: {
      keyframeCount,
      estimatedCostPerFrame: ESTIMATED_COST_PER_FRAME_USD,
      estimatedTotalCost: Math.round(estimatedTotalCost * 1000) / 1000,
      currency: 'USD',
    },
    feedbackSummary: {
      totalFeedbackEntries: feedbackResult.totalFeedbackEntries,
      statsByEventType: feedbackResult.statsByEventType.map((s) => ({
        eventType: s.eventType,
        totalEvents: s.totalEvents,
        correct: s.correct,
        incorrect: s.incorrect,
        boundaryEdit: s.boundaryEdit,
        missed: s.missed,
        precision: s.precision,
        recall: s.recall,
      })),
    },
  };

  return {
    content: JSON.stringify(report, null, 2),
    isError: false,
  };
}

/**
 * Processing pipeline service.
 *
 * Orchestrates the full media processing pipeline with reliability features:
 * - Sequential stage execution: preprocess -> map -> reduce
 * - Stage-level retries with exponential backoff
 * - Resumability: checks processing_stages to find last completed stage
 * - Cancellation support: cooperative cancellation via asset status = 'cancelled'
 * - Idempotency: respects content-hash dedup from media-store
 * - Graceful degradation: saves partial results on failure
 *
 * All reliability infrastructure is generic media-processing, not domain-specific.
 */

import {
  createProcessingStage,
  getMediaAssetById,
  getProcessingStagesForAsset,
  type ProcessingStage,
  updateMediaAssetStatus,
  updateProcessingStage,
} from "../../../../memory/media-store.js";
import { computeRetryDelay, sleep } from "../../../../util/retry.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PipelineStageName = "preprocess" | "map" | "reduce";

export interface StageHandler {
  /** Execute the stage. Throw on failure. */
  execute: (
    assetId: string,
    onProgress?: (msg: string) => void,
  ) => Promise<void>;
}

export interface PipelineOptions {
  /** Maximum retry attempts per stage (default: 3). */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff between retries (default: 1000). */
  baseDelayMs?: number;
  /** Progress callback for streaming status updates. */
  onProgress?: (message: string) => void;
}

export interface PipelineResult {
  assetId: string;
  completedStages: PipelineStageName[];
  failedStage: PipelineStageName | null;
  failureReason: string | null;
  cancelled: boolean;
  resumedFrom: PipelineStageName | null;
}

// ---------------------------------------------------------------------------
// Pipeline stage ordering
// ---------------------------------------------------------------------------

const STAGE_ORDER: PipelineStageName[] = ["preprocess", "map", "reduce"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findOrCreateStage(
  assetId: string,
  stageName: string,
): ProcessingStage {
  const stages = getProcessingStagesForAsset(assetId);
  const existing = stages.find((s) => s.stage === stageName);
  if (existing) return existing;
  return createProcessingStage({ assetId, stage: stageName });
}

function isStageCompleted(stage: ProcessingStage): boolean {
  return stage.status === "completed";
}

/**
 * Check if the asset has been cancelled. Cooperative cancellation:
 * the pipeline checks this between stages to allow graceful stopping.
 */
function isAssetCancelled(assetId: string): boolean {
  const asset = getMediaAssetById(assetId);
  if (!asset) return true;
  return (asset.status as string) === "cancelled";
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

/**
 * Run the full processing pipeline for a media asset.
 *
 * The pipeline is resumable: if previous stages are already completed,
 * execution resumes from the first incomplete stage. Each stage is
 * retried with exponential backoff on failure. If a stage exhausts
 * its retries, partial results are preserved and the pipeline stops.
 */
export async function runPipeline(
  assetId: string,
  handlers: Record<PipelineStageName, StageHandler>,
  options?: PipelineOptions,
): Promise<PipelineResult> {
  const maxRetries = options?.maxRetries ?? 3;
  const baseDelayMs = options?.baseDelayMs ?? 1000;
  const onProgress = options?.onProgress;

  const asset = getMediaAssetById(assetId);
  if (!asset) {
    throw new Error(`Media asset not found: ${assetId}`);
  }

  // Check if asset is already cancelled before forcing processing
  if ((asset.status as string) === "cancelled") {
    return {
      assetId,
      completedStages: [],
      failedStage: null,
      failureReason: null,
      cancelled: true,
      resumedFrom: null,
    };
  }

  // Mark asset as processing
  updateMediaAssetStatus(assetId, "processing");

  const completedStages: PipelineStageName[] = [];
  let failedStage: PipelineStageName | null = null;
  let failureReason: string | null = null;
  let cancelled = false;
  let resumedFrom: PipelineStageName | null = null;

  // Find where to resume from by checking existing stage records
  let startIndex = 0;
  for (let i = 0; i < STAGE_ORDER.length; i++) {
    const stage = findOrCreateStage(assetId, STAGE_ORDER[i]);
    if (isStageCompleted(stage)) {
      completedStages.push(STAGE_ORDER[i]);
      startIndex = i + 1;
    } else {
      break;
    }
  }

  if (startIndex > 0 && startIndex < STAGE_ORDER.length) {
    resumedFrom = STAGE_ORDER[startIndex];
    onProgress?.(`Resuming pipeline from stage: ${resumedFrom}`);
  } else if (startIndex >= STAGE_ORDER.length) {
    // All stages already completed — idempotent no-op
    onProgress?.("All pipeline stages already completed.");
    updateMediaAssetStatus(assetId, "indexed");
    return {
      assetId,
      completedStages,
      failedStage: null,
      failureReason: null,
      cancelled: false,
      resumedFrom: null,
    };
  }

  // Execute stages sequentially from the resume point
  for (let i = startIndex; i < STAGE_ORDER.length; i++) {
    const stageName = STAGE_ORDER[i];

    // Cooperative cancellation check between stages
    if (isAssetCancelled(assetId)) {
      onProgress?.(`Pipeline cancelled before stage: ${stageName}`);
      cancelled = true;
      break;
    }

    const stageRecord = findOrCreateStage(assetId, stageName);
    const handler = handlers[stageName];

    onProgress?.(`Starting stage: ${stageName}`);
    updateProcessingStage(stageRecord.id, {
      status: "running",
      startedAt: Date.now(),
      lastError: null,
    });

    let succeeded = false;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          const delay = computeRetryDelay(attempt - 1, baseDelayMs);
          onProgress?.(
            `Retrying stage ${stageName} (attempt ${attempt + 1}/${maxRetries + 1}) after ${Math.round(delay)}ms...`,
          );
          await sleep(delay);

          // Re-check cancellation before retry
          if (isAssetCancelled(assetId)) {
            onProgress?.(
              `Pipeline cancelled during retry of stage: ${stageName}`,
            );
            cancelled = true;
            break;
          }
        }

        await handler.execute(assetId, onProgress);

        // Mark stage as completed
        updateProcessingStage(stageRecord.id, {
          status: "completed",
          progress: 100,
          completedAt: Date.now(),
        });

        completedStages.push(stageName);
        succeeded = true;
        onProgress?.(`Completed stage: ${stageName}`);
        break;
      } catch (err) {
        const errorMsg = (err as Error).message.slice(0, 500);
        onProgress?.(
          `Stage ${stageName} failed (attempt ${attempt + 1}/${maxRetries + 1}): ${errorMsg}`,
        );

        // Save partial progress — the stage handler should have already
        // persisted any partial results before throwing
        updateProcessingStage(stageRecord.id, {
          status: attempt >= maxRetries ? "failed" : "running",
          lastError: errorMsg,
        });
      }
    }

    if (cancelled) break;

    if (!succeeded) {
      failedStage = stageName;
      failureReason = `Stage ${stageName} failed after ${maxRetries + 1} attempts`;
      onProgress?.(`Pipeline stopped: ${failureReason}`);
      break;
    }
  }

  // Update final asset status
  if (cancelled) {
    // Leave status as-is (already 'cancelled')
  } else if (failedStage) {
    updateMediaAssetStatus(assetId, "failed");
  } else {
    updateMediaAssetStatus(assetId, "indexed");
  }

  return {
    assetId,
    completedStages,
    failedStage,
    failureReason,
    cancelled,
    resumedFrom,
  };
}

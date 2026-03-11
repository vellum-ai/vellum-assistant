import {
  type PipelineStageName,
  runPipeline,
  type StageHandler,
} from "../../config/bundled-skills/media-processing/services/processing-pipeline.js";
import { mapSegmentsForAsset } from "../../config/bundled-skills/media-processing/tools/analyze-keyframes.js";
import { preprocessForAsset } from "../../config/bundled-skills/media-processing/tools/extract-keyframes.js";
import { reduceForAsset } from "../../config/bundled-skills/media-processing/tools/query-media-events.js";
import { getConfig } from "../../config/loader.js";
import { getLogger } from "../../util/logger.js";
import { selectedBackendSupportsMultimodal } from "../embedding-backend.js";
import { asString } from "../job-utils.js";
import { enqueueMemoryJob, type MemoryJob } from "../jobs-store.js";
import { getMediaAssetById, updateMediaAssetStatus } from "../media-store.js";

const log = getLogger("media-processing-job");

export async function mediaProcessingJob(job: MemoryJob): Promise<void> {
  const mediaAssetId = asString(job.payload.mediaAssetId);
  if (!mediaAssetId) {
    log.warn({ jobId: job.id }, "Missing mediaAssetId in job payload");
    return;
  }

  const asset = getMediaAssetById(mediaAssetId);
  if (!asset) {
    log.warn({ jobId: job.id, mediaAssetId }, "Media asset not found");
    return;
  }

  if (asset.mediaType !== "video") {
    log.info(
      { assetId: mediaAssetId, mediaType: asset.mediaType },
      "Skipping media processing pipeline — only video assets are supported",
    );
    updateMediaAssetStatus(mediaAssetId, "indexed");
    if (selectedBackendSupportsMultimodal(getConfig())) {
      enqueueMemoryJob("embed_media", { assetId: mediaAssetId });
    }
    return;
  }

  const handlers: Record<PipelineStageName, StageHandler> = {
    preprocess: {
      execute: async (assetId, onProgress) => {
        await preprocessForAsset(assetId, {}, onProgress);
      },
    },
    map: {
      execute: async (assetId, onProgress) => {
        await mapSegmentsForAsset(
          assetId,
          {
            systemPrompt:
              "Describe what you see in these video frames. For each frame, note: subjects present, actions occurring, scene context, and any text visible.",
            outputSchema: {
              type: "object",
              properties: {
                frames: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      timestamp: { type: "number" },
                      subjects: { type: "array", items: { type: "string" } },
                      actions: { type: "array", items: { type: "string" } },
                      scene: { type: "string" },
                      text: { type: "string" },
                    },
                  },
                },
              },
            },
          },
          onProgress,
        );
      },
    },
    reduce: {
      execute: async (assetId, onProgress) => {
        await reduceForAsset(
          assetId,
          {
            systemPrompt:
              "Summarize the video content based on the structured observations.",
          },
          onProgress,
        );
      },
    },
  };

  const result = await runPipeline(mediaAssetId, handlers, {
    onProgress: (msg) => log.info({ mediaAssetId }, msg),
  });

  log.info(
    {
      mediaAssetId,
      completedStages: result.completedStages,
      failedStage: result.failedStage,
      cancelled: result.cancelled,
    },
    "Media processing pipeline finished",
  );

  if (result.failedStage) {
    throw new Error(
      `Media processing failed at stage ${result.failedStage}: ${result.failureReason}`,
    );
  }
  if (result.cancelled) {
    throw new Error(`Media processing cancelled for asset ${mediaAssetId}`);
  }

  updateMediaAssetStatus(mediaAssetId, "indexed");
  if (selectedBackendSupportsMultimodal(getConfig())) {
    enqueueMemoryJob("embed_media", { assetId: mediaAssetId });
  }
}

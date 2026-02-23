import { getLogger } from '../../util/logger.js';
import { asString } from '../job-utils.js';
import { getMediaAssetById } from '../media-store.js';
import type { MemoryJob } from '../jobs-store.js';
import {
  runPipeline,
  type PipelineStageName,
  type StageHandler,
} from '../../config/bundled-skills/media-processing/services/processing-pipeline.js';
import { extractKeyframesForAsset } from '../../config/bundled-skills/media-processing/tools/extract-keyframes.js';
import { analyzeKeyframesForAsset } from '../../config/bundled-skills/media-processing/tools/analyze-keyframes.js';
import { generateTimeline } from '../../config/bundled-skills/media-processing/services/timeline-service.js';
import {
  detectEvents,
  type DetectionConfig,
} from '../../config/bundled-skills/media-processing/services/event-detection-service.js';

const log = getLogger('media-processing-job');

const defaultDetectionConfig: DetectionConfig = {
  eventType: 'scene_change',
  rules: [
    {
      ruleType: 'segment_transition',
      params: { field: 'segmentType' },
      weight: 1.0,
    },
  ],
};

export async function mediaProcessingJob(job: MemoryJob): Promise<void> {
  const mediaAssetId = asString(job.payload.mediaAssetId);
  if (!mediaAssetId) {
    log.warn({ jobId: job.id }, 'Missing mediaAssetId in job payload');
    return;
  }

  const asset = getMediaAssetById(mediaAssetId);
  if (!asset) {
    log.warn({ jobId: job.id, mediaAssetId }, 'Media asset not found');
    return;
  }

  // Build detection config, allowing optional eventType override from payload
  const eventType = asString(job.payload.eventType);
  const detectionConfig: DetectionConfig = eventType
    ? { ...defaultDetectionConfig, eventType }
    : defaultDetectionConfig;

  const handlers: Record<PipelineStageName, StageHandler> = {
    keyframe_extraction: {
      execute: (assetId, onProgress) =>
        extractKeyframesForAsset(assetId, 1, onProgress),
    },
    vision_analysis: {
      execute: (assetId, onProgress) =>
        analyzeKeyframesForAsset(assetId, undefined, undefined, onProgress),
    },
    timeline_generation: {
      execute: async (assetId, onProgress) => {
        generateTimeline(assetId, { onProgress });
      },
    },
    event_detection: {
      execute: async (assetId, onProgress) => {
        detectEvents(assetId, detectionConfig, { onProgress });
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
    'Media processing pipeline finished',
  );
}

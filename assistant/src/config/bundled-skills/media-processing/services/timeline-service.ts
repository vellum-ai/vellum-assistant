/**
 * Timeline generation service.
 *
 * Aggregates sequential vision outputs into coherent timeline segments.
 * Each segment groups adjacent keyframes that share similar scene characteristics
 * into a single time range with merged attributes.
 */

import {
  getMediaAssetById,
  getKeyframesForAsset,
  getVisionOutputsForAsset,
  deleteTimelineForAsset,
  insertTimelineSegmentsBatch,
  createProcessingStage,
  updateProcessingStage,
  getProcessingStagesForAsset,
  type MediaVisionOutput,
  type MediaKeyframe,
  type MediaTimeline,
} from '../../../../memory/media-store.js';

export interface TimelineGenerationResult {
  assetId: string;
  segmentCount: number;
  segments: MediaTimeline[];
}

/**
 * Generate a timeline for a media asset from its vision analysis outputs.
 *
 * Groups consecutive keyframes with similar scene descriptions into segments.
 * If a timeline already exists for this asset, it is replaced.
 */
export function generateTimeline(
  assetId: string,
  options?: {
    analysisType?: string;
    onProgress?: (message: string) => void;
  },
): TimelineGenerationResult {
  const analysisType = options?.analysisType ?? 'scene_description';
  const onProgress = options?.onProgress;

  const asset = getMediaAssetById(assetId);
  if (!asset) {
    throw new Error(`Media asset not found: ${assetId}`);
  }

  const keyframes = getKeyframesForAsset(assetId);
  if (keyframes.length === 0) {
    throw new Error('No keyframes found for this asset. Run extract_keyframes first.');
  }

  const visionOutputs = getVisionOutputsForAsset(assetId, analysisType);
  if (visionOutputs.length === 0) {
    throw new Error(`No vision outputs found for analysis type "${analysisType}". Run analyze_keyframes first.`);
  }

  // Find or create the timeline_generation processing stage
  const existingStages = getProcessingStagesForAsset(assetId);
  let stage = existingStages.find((s) => s.stage === 'timeline_generation');
  if (!stage) {
    stage = createProcessingStage({ assetId, stage: 'timeline_generation' });
  }
  updateProcessingStage(stage.id, { status: 'running', startedAt: Date.now() });

  try {
    // Build a map of keyframeId -> keyframe for timestamp lookup
    const keyframeMap = new Map<string, MediaKeyframe>();
    for (const kf of keyframes) {
      keyframeMap.set(kf.id, kf);
    }

    // Build a map of keyframeId -> vision output
    const outputByKeyframe = new Map<string, MediaVisionOutput>();
    for (const vo of visionOutputs) {
      outputByKeyframe.set(vo.keyframeId, vo);
    }

    // Sort keyframes by timestamp to ensure sequential processing
    const sortedKeyframes = [...keyframes]
      .filter((kf) => outputByKeyframe.has(kf.id))
      .sort((a, b) => a.timestamp - b.timestamp);

    if (sortedKeyframes.length === 0) {
      updateProcessingStage(stage.id, {
        status: 'completed',
        progress: 100,
        completedAt: Date.now(),
      });
      return { assetId, segmentCount: 0, segments: [] };
    }

    onProgress?.('Aggregating vision outputs into timeline segments...');

    // Aggregate consecutive frames into segments based on scene similarity
    const segmentRows: Array<{
      assetId: string;
      startTime: number;
      endTime: number;
      segmentType: string;
      attributes: Record<string, unknown>;
      confidence: number;
    }> = [];

    let currentSegment = createSegmentFromOutput(
      assetId,
      sortedKeyframes[0],
      outputByKeyframe.get(sortedKeyframes[0].id)!,
    );

    for (let i = 1; i < sortedKeyframes.length; i++) {
      const kf = sortedKeyframes[i];
      const vo = outputByKeyframe.get(kf.id)!;

      if (shouldMergeIntoSegment(currentSegment, vo)) {
        // Extend the current segment
        currentSegment.endTime = kf.timestamp;
        const newConfidence = vo.confidence ?? 0.5;
        currentSegment.confidence =
          (currentSegment.confidence * currentSegment.frameCount + newConfidence) / (currentSegment.frameCount + 1);
        currentSegment.frameCount++;
        mergeSubjects(currentSegment.attributes, vo.output);
        mergeActions(currentSegment.attributes, vo.output);
      } else {
        // Finalize current segment and start a new one
        segmentRows.push(currentSegment);
        currentSegment = createSegmentFromOutput(assetId, kf, vo);
      }

      // Update progress
      const progress = Math.round((i / sortedKeyframes.length) * 100);
      updateProcessingStage(stage.id, { progress });
    }

    // Don't forget the last segment
    segmentRows.push(currentSegment);

    // Clear existing timeline and insert new segments
    deleteTimelineForAsset(assetId);
    const segments = insertTimelineSegmentsBatch(segmentRows);

    updateProcessingStage(stage.id, {
      status: 'completed',
      progress: 100,
      completedAt: Date.now(),
    });

    onProgress?.(`Generated ${segments.length} timeline segments.`);

    return { assetId, segmentCount: segments.length, segments };
  } catch (err) {
    updateProcessingStage(stage.id, {
      status: 'failed',
      lastError: (err as Error).message.slice(0, 500),
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface PendingSegment {
  assetId: string;
  startTime: number;
  endTime: number;
  segmentType: string;
  attributes: Record<string, unknown>;
  confidence: number;
  frameCount: number;
}

function createSegmentFromOutput(
  assetId: string,
  keyframe: MediaKeyframe,
  vo: MediaVisionOutput,
): PendingSegment {
  const sceneDescription = (vo.output.sceneDescription as string) ?? '';
  const segmentType = deriveSegmentType(vo.output);
  return {
    assetId,
    startTime: keyframe.timestamp,
    endTime: keyframe.timestamp,
    segmentType,
    attributes: {
      sceneDescription,
      subjects: Array.isArray(vo.output.subjects) ? [...(vo.output.subjects as string[])] : [],
      actions: Array.isArray(vo.output.actions) ? [...(vo.output.actions as string[])] : [],
      context: (vo.output.context as string) ?? '',
    },
    confidence: vo.confidence ?? 0.5,
    frameCount: 1,
  };
}

/**
 * Derive a generic segment type from vision output.
 * Uses simple heuristics on the scene description — domain-specific
 * interpretation belongs in the VLM prompt, not here.
 */
function deriveSegmentType(output: Record<string, unknown>): string {
  const actions = output.actions as string[] | undefined;
  if (actions && actions.length > 0) {
    return 'activity';
  }
  const subjects = output.subjects as string[] | undefined;
  if (subjects && subjects.length > 0) {
    return 'scene';
  }
  return 'static';
}

/**
 * Decide whether a new vision output is similar enough to merge
 * into the current segment.
 *
 * Uses a simple heuristic: same segment type and overlapping subjects.
 */
function shouldMergeIntoSegment(
  segment: PendingSegment,
  vo: MediaVisionOutput,
): boolean {
  const newType = deriveSegmentType(vo.output);
  if (newType !== segment.segmentType) return false;

  // Check subject overlap
  const existingSubjects = new Set(
    (segment.attributes.subjects as string[]) ?? [],
  );
  const newSubjects = (vo.output.subjects as string[]) ?? [];

  if (existingSubjects.size === 0 && newSubjects.length === 0) return true;
  if (existingSubjects.size === 0 || newSubjects.length === 0) return false;

  const overlap = newSubjects.filter((s) => existingSubjects.has(s)).length;
  const unionSize = new Set([...existingSubjects, ...newSubjects]).size;

  // Merge if at least 30% overlap (Jaccard similarity)
  return unionSize > 0 && overlap / unionSize >= 0.3;
}

function mergeSubjects(
  attributes: Record<string, unknown>,
  newOutput: Record<string, unknown>,
): void {
  const existing = new Set((attributes.subjects as string[]) ?? []);
  const incoming = (newOutput.subjects as string[]) ?? [];
  for (const s of incoming) {
    existing.add(s);
  }
  attributes.subjects = [...existing];
}

function mergeActions(
  attributes: Record<string, unknown>,
  newOutput: Record<string, unknown>,
): void {
  const existing = new Set((attributes.actions as string[]) ?? []);
  const incoming = (newOutput.actions as string[]) ?? [];
  for (const a of incoming) {
    existing.add(a);
  }
  attributes.actions = [...existing];
}

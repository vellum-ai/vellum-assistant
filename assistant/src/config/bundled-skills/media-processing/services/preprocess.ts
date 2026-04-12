import { randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  createProcessingStage,
  deleteKeyframesForAsset,
  getMediaAssetById,
  getProcessingStagesForAsset,
  insertKeyframesBatch,
  type ProcessingStage,
  updateProcessingStage,
} from "../../../../memory/media-store.js";
import { silentlyWithLog } from "../../../../util/silently.js";
import {
  FFMPEG_PALETTE_TIMEOUT_MS,
  FFMPEG_PREPROCESS_TIMEOUT_MS,
  spawnWithTimeout,
} from "../../../../util/spawn.js";
import { transcribeSegmentAudio } from "./audio-transcribe.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_FRAMES_PER_SEGMENT = 4;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PreprocessConfig {
  intervalSeconds: number;
  shortEdge: number;
  deadTimeThreshold: number;
  segmentDuration: number;
}

export interface TimeRange {
  start: number;
  end: number;
}

export interface Segment {
  id: string;
  startSeconds: number;
  endSeconds: number;
  framePaths: string[];
  frameTimestamps: number[];
  transcript?: string;
}

export interface SubjectGroup {
  label: string;
  dominantColor: string;
  identifiers: string[];
}

export interface SubjectRegistry {
  groups: SubjectGroup[];
}

export interface SectionBoundary {
  label: string;
  startSeconds: number;
  endSeconds: number;
}

export interface PreprocessManifest {
  assetId: string;
  videoPath: string;
  durationSeconds: number;
  segments: Segment[];
  deadTimeRanges: TimeRange[];
  subjectRegistry: SubjectRegistry;
  sectionBoundaries: SectionBoundary[];
  config: PreprocessConfig;
}

export interface PreprocessOptions {
  intervalSeconds?: number;
  segmentDuration?: number;
  deadTimeThreshold?: number;
  sectionConfigPath?: string;
  detectDeadTime?: boolean;
  shortEdge?: number;
  includeAudio?: boolean;
  transcriptionMode?: "api" | "local";
  openaiApiKey?: string;
}

// ---------------------------------------------------------------------------
// Pure functions (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Parse mpdecimate filter stderr output to extract dropped frame timestamps.
 * mpdecimate logs lines like:
 *   pts_time:12.34 ... drop
 * We collect the pts_time values of dropped frames.
 */
export function parseDroppedFrameTimestamps(stderr: string): number[] {
  const timestamps: number[] = [];
  const lines = stderr.split("\n");
  for (const line of lines) {
    // mpdecimate marks dropped frames with "drop" at the end of the line
    if (!line.includes("drop")) continue;
    const match = line.match(/pts_time:([\d.]+)/);
    if (match) {
      timestamps.push(parseFloat(match[1]));
    }
  }
  return timestamps.sort((a, b) => a - b);
}

/**
 * Build dead-time ranges from dropped frame timestamps.
 * Groups consecutive dropped frames and merges ranges where the gap
 * between dropped frames is small (within gapThresholdSeconds).
 * Only ranges longer than minDurationSeconds are kept.
 */
export function buildDeadTimeRanges(
  droppedTimestamps: number[],
  gapThresholdSeconds: number = 1.0,
  minDurationSeconds: number = 5.0,
): TimeRange[] {
  if (droppedTimestamps.length === 0) return [];

  const ranges: TimeRange[] = [];
  let rangeStart = droppedTimestamps[0];
  let rangeEnd = droppedTimestamps[0];

  for (let i = 1; i < droppedTimestamps.length; i++) {
    const ts = droppedTimestamps[i];
    if (ts - rangeEnd <= gapThresholdSeconds) {
      // Extend current range
      rangeEnd = ts;
    } else {
      // Close current range if long enough
      if (rangeEnd - rangeStart >= minDurationSeconds) {
        ranges.push({ start: rangeStart, end: rangeEnd });
      }
      rangeStart = ts;
      rangeEnd = ts;
    }
  }

  // Close final range
  if (rangeEnd - rangeStart >= minDurationSeconds) {
    ranges.push({ start: rangeStart, end: rangeEnd });
  }

  return ranges;
}

/**
 * Compute live time ranges by subtracting dead-time ranges from the total duration.
 */
export function computeLiveRanges(
  durationSeconds: number,
  deadTimeRanges: TimeRange[],
): TimeRange[] {
  if (deadTimeRanges.length === 0) {
    return [{ start: 0, end: durationSeconds }];
  }

  const sorted = [...deadTimeRanges].sort((a, b) => a.start - b.start);
  const live: TimeRange[] = [];
  let cursor = 0;

  for (const dead of sorted) {
    if (dead.start > cursor) {
      live.push({ start: cursor, end: dead.start });
    }
    cursor = Math.max(cursor, dead.end);
  }

  if (cursor < durationSeconds) {
    live.push({ start: cursor, end: durationSeconds });
  }

  return live;
}

/**
 * Create non-overlapping segments of a given duration within live time ranges.
 */
export function createSegments(
  liveRanges: TimeRange[],
  segmentDuration: number,
): Array<{ id: string; startSeconds: number; endSeconds: number }> {
  if (segmentDuration <= 0) {
    throw new Error(`segmentDuration must be positive, got ${segmentDuration}`);
  }

  const segments: Array<{
    id: string;
    startSeconds: number;
    endSeconds: number;
  }> = [];
  let segIndex = 0;

  for (const range of liveRanges) {
    let cursor = range.start;
    while (cursor < range.end) {
      const end = Math.min(cursor + segmentDuration, range.end);
      segIndex++;
      const id = `seg-${String(segIndex).padStart(3, "0")}`;
      segments.push({ id, startSeconds: cursor, endSeconds: end });
      cursor = end;
    }
  }

  return segments;
}

/**
 * Compute the effective frame extraction interval for a segment,
 * ensuring at least MIN_FRAMES_PER_SEGMENT frames are produced.
 */
export function computeEffectiveInterval(
  segmentDurationSeconds: number,
  requestedInterval: number,
): number {
  const framesAtRequestedInterval = Math.floor(
    segmentDurationSeconds / requestedInterval,
  );
  if (framesAtRequestedInterval >= MIN_FRAMES_PER_SEGMENT) {
    return requestedInterval;
  }
  // Reduce interval to guarantee minimum frame count
  return segmentDurationSeconds / MIN_FRAMES_PER_SEGMENT;
}

/**
 * Generate frame timestamps for a segment based on effective interval.
 */
export function generateFrameTimestamps(
  segStart: number,
  segEnd: number,
  interval: number,
): number[] {
  const effectiveInterval = computeEffectiveInterval(
    segEnd - segStart,
    interval,
  );
  const timestamps: number[] = [];
  let t = segStart;
  while (t < segEnd) {
    timestamps.push(parseFloat(t.toFixed(3)));
    t += effectiveInterval;
  }
  return timestamps;
}

/**
 * Create default section boundaries by splitting the duration into equal halves.
 */
export function createDefaultSections(
  durationSeconds: number,
): SectionBoundary[] {
  const mid = durationSeconds / 2;
  return [
    { label: "section_1", startSeconds: 0, endSeconds: mid },
    { label: "section_2", startSeconds: mid, endSeconds: durationSeconds },
  ];
}

// ---------------------------------------------------------------------------
// Subject registry (color sampling)
// ---------------------------------------------------------------------------

/**
 * Sample ~10 frames evenly spread across the video for subject registry analysis.
 * Returns indices into the total frame set.
 */
export function sampleFrameIndices(
  totalFrames: number,
  sampleCount: number = 10,
): number[] {
  if (totalFrames <= sampleCount) {
    return Array.from({ length: totalFrames }, (_, i) => i);
  }
  const step = totalFrames / sampleCount;
  const indices: number[] = [];
  for (let i = 0; i < sampleCount; i++) {
    indices.push(Math.min(Math.floor(i * step), totalFrames - 1));
  }
  return indices;
}

/**
 * Extract dominant colors from a frame image using ffmpeg's thumbnail and showinfo filters.
 * Returns hex color strings.
 */
async function extractDominantColors(framePath: string): Promise<string[]> {
  // Use ffmpeg to extract a palette from the frame
  const result = await spawnWithTimeout(
    [
      "ffmpeg",
      "-i",
      framePath,
      "-vf",
      "palettegen=max_colors=4:stats_mode=diff",
      "-f",
      "null",
      "-",
    ],
    FFMPEG_PALETTE_TIMEOUT_MS,
  );

  // Fallback: return empty if analysis fails
  if (result.exitCode !== 0) return [];

  // Parse palette info from stderr - look for color hex values
  const colors: string[] = [];
  const colorMatches = result.stderr.matchAll(/0x([0-9a-fA-F]{6})/g);
  for (const m of colorMatches) {
    colors.push(`#${m[1].toLowerCase()}`);
  }
  return colors.length > 0 ? colors.slice(0, 4) : [];
}

/**
 * Build a subject registry by sampling frames and detecting dominant non-background colors.
 */
async function buildSubjectRegistry(
  framePaths: string[],
): Promise<SubjectRegistry> {
  if (framePaths.length === 0) {
    return { groups: [] };
  }

  const indices = sampleFrameIndices(framePaths.length);
  const sampledPaths = indices.map((i) => framePaths[i]).filter(Boolean);

  // Collect all dominant colors across sampled frames
  const colorCounts = new Map<string, number>();
  for (const path of sampledPaths) {
    const colors = await extractDominantColors(path);
    for (const c of colors) {
      colorCounts.set(c, (colorCounts.get(c) || 0) + 1);
    }
  }

  // Sort by frequency and pick top groups (skip very common colors likely to be court/background)
  const sorted = [...colorCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4);

  const groups: SubjectGroup[] = sorted.map((entry, i) => ({
    label: `group_${String.fromCharCode(97 + i)}`,
    dominantColor: entry[0],
    identifiers: [],
  }));

  return { groups };
}

// ---------------------------------------------------------------------------
// Main preprocess function
// ---------------------------------------------------------------------------

export async function preprocessForAsset(
  assetId: string,
  options: PreprocessOptions = {},
  onProgress?: (msg: string) => void,
): Promise<PreprocessManifest> {
  const config: PreprocessConfig = {
    intervalSeconds: options.intervalSeconds ?? 1,
    segmentDuration: options.segmentDuration ?? 15,
    deadTimeThreshold: options.deadTimeThreshold ?? 0.02,
    shortEdge: options.shortEdge ?? 480,
  };

  const detectDeadTime = options.detectDeadTime ?? false;

  const asset = getMediaAssetById(assetId);
  if (!asset) {
    throw new Error(`Media asset not found: ${assetId}`);
  }
  if (asset.mediaType !== "video") {
    throw new Error(
      `Preprocess requires a video asset. Got: ${asset.mediaType}`,
    );
  }

  const durationSeconds = asset.durationSeconds ?? 0;
  if (durationSeconds <= 0) {
    throw new Error("Video asset has no duration information.");
  }

  // Find or create processing stage
  let stage: ProcessingStage | undefined;
  const existingStages = getProcessingStagesForAsset(assetId);
  stage = existingStages.find((s) => s.stage === "preprocess");
  if (!stage) {
    stage = createProcessingStage({ assetId, stage: "preprocess" });
  }
  updateProcessingStage(stage.id, { status: "running", startedAt: Date.now() });

  const pipelineDir = join(dirname(asset.filePath), "pipeline", assetId);
  const framesDir = join(pipelineDir, "frames");
  const tempDir = framesDir + "-tmp-" + randomUUID();
  await mkdir(tempDir, { recursive: true });

  try {
    // Step 1: Dead-time detection
    let deadTimeRanges: TimeRange[] = [];

    if (detectDeadTime) {
      onProgress?.("Detecting dead time with mpdecimate filter...\n");
      const mpdecimateResult = await spawnWithTimeout(
        [
          "ffmpeg",
          "-i",
          asset.filePath,
          "-vf",
          `mpdecimate=hi=64*${config.deadTimeThreshold}:lo=64*${config.deadTimeThreshold}:frac=1`,
          "-loglevel",
          "debug",
          "-f",
          "null",
          "-",
        ],
        FFMPEG_PREPROCESS_TIMEOUT_MS,
      );

      const droppedTimestamps = parseDroppedFrameTimestamps(
        mpdecimateResult.stderr,
      );
      deadTimeRanges = buildDeadTimeRanges(droppedTimestamps);
      onProgress?.(`Found ${deadTimeRanges.length} dead-time range(s).\n`);
    }

    // Step 2: Segmentation
    onProgress?.("Creating segments...\n");
    const liveRanges = computeLiveRanges(durationSeconds, deadTimeRanges);
    const rawSegments = createSegments(liveRanges, config.segmentDuration);
    onProgress?.(
      `Created ${rawSegments.length} segment(s) from ${liveRanges.length} live range(s).\n`,
    );

    // Step 3: Frame extraction per segment
    onProgress?.("Extracting frames per segment...\n");
    const segments: Segment[] = [];
    const allFramePaths: string[] = [];

    const scaleFilter = `scale='if(gt(iw,ih),-1,${config.shortEdge})':'if(gt(iw,ih),${config.shortEdge},-1)'`;

    for (let i = 0; i < rawSegments.length; i++) {
      const seg = rawSegments[i];
      const segDuration = seg.endSeconds - seg.startSeconds;
      const effectiveInterval = computeEffectiveInterval(
        segDuration,
        config.intervalSeconds,
      );
      const _frameTimestamps = generateFrameTimestamps(
        seg.startSeconds,
        seg.endSeconds,
        config.intervalSeconds,
      );

      const segTempDir = join(tempDir, seg.id);
      await mkdir(segTempDir, { recursive: true });

      const vfFilter = `fps=1/${effectiveInterval},${scaleFilter}`;

      const result = await spawnWithTimeout(
        [
          "ffmpeg",
          "-y",
          "-ss",
          String(seg.startSeconds),
          "-t",
          String(segDuration),
          "-i",
          asset.filePath,
          "-vf",
          vfFilter,
          "-q:v",
          "2",
          join(segTempDir, "frame-%06d.jpg"),
        ],
        FFMPEG_PREPROCESS_TIMEOUT_MS,
      );

      if (result.exitCode !== 0) {
        onProgress?.(
          `Warning: frame extraction failed for ${seg.id}: ${result.stderr.slice(0, 200)}\n`,
        );
        const segProgress = Math.round(((i + 1) / rawSegments.length) * 80);
        updateProcessingStage(stage.id, { progress: segProgress });
        continue;
      }

      const files = await readdir(segTempDir);
      const frameFiles = files
        .filter((f) => f.startsWith("frame-") && f.endsWith(".jpg"))
        .sort();

      const framePaths = frameFiles.map((f) => join(framesDir, seg.id, f));
      allFramePaths.push(
        ...framePaths.map((_, i) => join(segTempDir, frameFiles[i])),
      );

      // Use actual extracted frame count to recalculate timestamps
      const actualTimestamps = frameFiles.map((_, i) =>
        parseFloat((seg.startSeconds + i * effectiveInterval).toFixed(3)),
      );

      const segment: Segment = {
        id: seg.id,
        startSeconds: seg.startSeconds,
        endSeconds: seg.endSeconds,
        framePaths,
        frameTimestamps: actualTimestamps,
      };

      if (options.includeAudio) {
        const transcript = await transcribeSegmentAudio(
          asset.filePath,
          seg.startSeconds,
          seg.endSeconds - seg.startSeconds,
        );
        if (transcript) {
          segment.transcript = transcript;
        }
      }

      segments.push(segment);

      const segProgress = Math.round(((i + 1) / rawSegments.length) * 80);
      updateProcessingStage(stage.id, { progress: segProgress });
    }

    const totalFrames = segments.reduce(
      (sum, s) => sum + s.framePaths.length,
      0,
    );
    if (rawSegments.length > 0 && totalFrames === 0) {
      throw new Error(
        `All ${rawSegments.length} segment(s) failed frame extraction - zero usable frames produced.`,
      );
    }
    onProgress?.(
      `Extracted ${totalFrames} total frames across ${segments.length} segments.\n`,
    );

    // Atomically swap temp dir to durable path
    await rm(framesDir, { recursive: true, force: true });
    await mkdir(dirname(framesDir), { recursive: true });
    await rename(tempDir, framesDir);

    // Step 4: Subject registry
    onProgress?.("Building subject registry...\n");
    const allExtractedPaths = segments.flatMap((s) => s.framePaths);
    const subjectRegistry = await buildSubjectRegistry(allExtractedPaths);
    onProgress?.(
      `Identified ${subjectRegistry.groups.length} subject group(s).\n`,
    );
    updateProcessingStage(stage.id, { progress: 90 });

    // Step 5: Section boundaries
    let sectionBoundaries: SectionBoundary[];
    if (options.sectionConfigPath) {
      const raw = await readFile(options.sectionConfigPath, "utf-8");
      sectionBoundaries = JSON.parse(raw) as SectionBoundary[];
    } else {
      sectionBoundaries = createDefaultSections(durationSeconds);
    }

    // Step 6: Register keyframes in DB
    onProgress?.("Registering keyframes in database...\n");
    deleteKeyframesForAsset(assetId);

    const keyframeRows = segments.flatMap((seg) =>
      seg.framePaths.map((fp, i) => ({
        assetId,
        timestamp:
          seg.frameTimestamps[i] ??
          seg.startSeconds + i * config.intervalSeconds,
        filePath: fp,
        metadata: {
          segmentId: seg.id,
          frameIndex: i,
          intervalSeconds: config.intervalSeconds,
        },
      })),
    );

    if (keyframeRows.length > 0) {
      insertKeyframesBatch(keyframeRows);
    }
    updateProcessingStage(stage.id, { progress: 95 });

    // Step 7: Write manifest
    const manifest: PreprocessManifest = {
      assetId,
      videoPath: asset.filePath,
      durationSeconds,
      segments,
      deadTimeRanges,
      subjectRegistry,
      sectionBoundaries,
      config,
    };

    const manifestPath = join(pipelineDir, "manifest.json");
    await mkdir(pipelineDir, { recursive: true });
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    // Update stage
    updateProcessingStage(stage.id, {
      status: "completed",
      progress: 100,
      completedAt: Date.now(),
    });

    onProgress?.(`Preprocess complete. Manifest written to ${manifestPath}\n`);

    return manifest;
  } catch (err) {
    await silentlyWithLog(
      rm(tempDir, { recursive: true, force: true }),
      "preprocess temp cleanup",
    );
    const msg = (err as Error).message;
    updateProcessingStage(stage.id, {
      status: "failed",
      lastError: msg.slice(0, 500),
    });
    throw err;
  }
}

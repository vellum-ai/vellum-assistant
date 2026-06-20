/**
 * Sample timestamped keyframes from a video attachment for the vision call site.
 *
 * Frames are extracted with `ffmpeg` (duration probed with `ffprobe`) via the
 * shared {@link spawnWithTimeout} helper, which augments PATH for Homebrew tools
 * and enforces a timeout. Both binaries may be absent in a given runtime; every
 * failure path — missing binary, probe failure, extraction failure, an
 * unreadable attachment — is reported as a typed {@link VideoFramesError} the
 * calling tool converts into a `{ isError: true }` result. This module never
 * throws an untyped error and never crashes the daemon.
 *
 * The frame count is capped so the resulting request fits the vision call site's
 * context window (Qwen 3.7 Plus, 262144 tokens). When the cap or the requested
 * sampling window forces us to drop frames, the result carries a `truncated`
 * descriptor so the tool can surface the omission rather than silently lying
 * about coverage.
 */

import { randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { optimizeImageForTransport } from "../../../../agent/image-optimize.js";
import {
  getAttachmentById,
  getFilePathForAttachment,
} from "../../../../memory/attachments-store.js";
import type { ImageContent } from "../../../../providers/types.js";
import { getLogger } from "../../../../util/logger.js";
import {
  FFMPEG_PALETTE_TIMEOUT_MS,
  FFPROBE_TIMEOUT_MS,
  spawnWithTimeout,
} from "../../../../util/spawn.js";
import { toImageBlock } from "./image-block.js";

const log = getLogger("vision-perception-video-frames");

/**
 * Raised when a video cannot be turned into sampled frames — the attachment is
 * missing or not a video, ffmpeg/ffprobe is unavailable, or extraction failed.
 * The calling tool converts this into a `{ isError: true }` result rather than
 * throwing.
 */
export class VideoFramesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VideoFramesError";
  }
}

/** A single sampled frame: its position in the video and the image block. */
export interface SampledFrame {
  t_seconds: number;
  block: ImageContent;
}

/** Sampling strategies the tool exposes (single source for the type, the tool's
 * runtime validation list, and its input-schema enum). */
export const SAMPLE_STRATEGIES = [
  "keyframes",
  "uniform_1hz",
  "uniform_4hz",
] as const;

/** A sampling strategy the tool exposes. */
export type SampleStrategy = (typeof SAMPLE_STRATEGIES)[number];

/** Why and how the frame set was capped, so the tool never truncates silently. */
export interface FramesTruncation {
  reason: string;
  /** Frames the sampling plan asked for before the cap. */
  requested: number;
  /** Frames actually returned. */
  returned: number;
  /** Covered time span `[start, end]` in seconds. */
  covered_window: [number, number];
}

export interface SampledVideo {
  duration_s: number;
  frames: SampledFrame[];
  truncated?: FramesTruncation;
}

export interface SampleVideoOptions {
  /** Sampling strategy. Defaults to `"keyframes"` (uniform over the whole clip). */
  sample?: SampleStrategy;
  /** Restrict sampling to `[start, end]` seconds of the clip. */
  window?: [number, number];
  /** Cooperative cancellation. */
  signal?: AbortSignal;
}

/**
 * Hard ceiling on frames per request. Each optimized JPEG runs to a few hundred
 * image tokens for the vision model; capping at 32 keeps the full message
 * (frames + prompt + response budget) comfortably inside Qwen 3.7 Plus's 262144
 * token context window with headroom for the model's own output.
 */
export const MAX_FRAMES = 32;

/** Per-strategy target sampling rate in frames per second. `null` = keyframe scene cuts. */
const STRATEGY_FPS: Record<SampleStrategy, number | null> = {
  keyframes: null,
  uniform_1hz: 1,
  uniform_4hz: 4,
};

/**
 * Seconds to pull the final sampled timestamp back from the video's end.
 * Seeking ffmpeg to exactly the duration (EOF) commonly yields no frame / an
 * empty file, which would make {@link extractFrameAt} throw and turn an ordinary
 * clip into a `{ isError: true }` result. Clamping every timestamp to at most
 * `duration - EPSILON` keeps us on a real frame just before the end.
 */
export const END_EPSILON_S = 0.1;

/**
 * Translate a {@link spawnWithTimeout} run into a typed error vocabulary: a
 * thrown promise (the binary could not be spawned — absent in this environment)
 * and a non-zero exit both become {@link VideoFramesError}.
 */
async function runFfTool(
  cmd: string[],
  timeoutMs: number,
  what: string,
): Promise<{ stdout: string; stderr: string }> {
  let result: Awaited<ReturnType<typeof spawnWithTimeout>>;
  try {
    result = await spawnWithTimeout(cmd, timeoutMs);
  } catch {
    throw new VideoFramesError(
      `${cmd[0]} is not available, so ${what} is not possible in this environment.`,
    );
  }
  if (result.exitCode !== 0) {
    throw new VideoFramesError(
      `${what} failed (exit ${result.exitCode}).` +
        (result.stderr ? ` ${result.stderr.slice(0, 400)}` : ""),
    );
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

/** Probe a video's duration in seconds with ffprobe. */
async function probeDurationSeconds(inputPath: string): Promise<number> {
  const { stdout } = await runFfTool(
    [
      "ffprobe",
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      inputPath,
    ],
    FFPROBE_TIMEOUT_MS,
    "reading the video's duration",
  );
  const duration = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new VideoFramesError("Could not determine the video's duration.");
  }
  return duration;
}

/** Extract a single JPEG frame at `tSeconds`, returned as base64 (or throws). */
async function extractFrameAt(
  inputPath: string,
  tSeconds: number,
): Promise<string> {
  const outputPath = join(tmpdir(), `vellum-vframe-${randomUUID()}.jpg`);
  try {
    await runFfTool(
      [
        "ffmpeg",
        "-y",
        "-ss",
        tSeconds.toFixed(3),
        "-i",
        inputPath,
        "-frames:v",
        "1",
        "-vf",
        "scale=720:-2",
        "-q:v",
        "5",
        outputPath,
      ],
      FFMPEG_PALETTE_TIMEOUT_MS,
      `extracting a video frame at ${tSeconds.toFixed(1)}s`,
    );
    const bytes = await readFile(outputPath);
    if (bytes.length === 0) {
      throw new VideoFramesError(
        `ffmpeg produced an empty frame at ${tSeconds.toFixed(1)}s.`,
      );
    }
    return bytes.toString("base64");
  } catch (err) {
    if (err instanceof VideoFramesError) throw err;
    throw new VideoFramesError(
      `Failed to read the extracted frame at ${tSeconds.toFixed(1)}s.`,
    );
  } finally {
    await unlink(outputPath).catch(() => {});
  }
}

/**
 * Compute the timestamps to sample. Uniform strategies sample at their target
 * rate across the window; the `keyframes` strategy samples uniformly across the
 * window (a robust, deterministic proxy for scene coverage without a second
 * decode pass). The list is capped at {@link MAX_FRAMES}; the returned
 * `requested` reflects the pre-cap count so the caller can report truncation.
 *
 * Every timestamp is held strictly below the clip's duration (by
 * {@link END_EPSILON_S}); see that constant for why seeking to EOF is avoided.
 * Exported for unit testing of that invariant.
 */
export function planTimestamps(
  durationS: number,
  windowStart: number,
  windowEnd: number,
  strategy: SampleStrategy,
): { timestamps: number[]; requested: number } {
  const span = Math.max(0, windowEnd - windowStart);
  const fps = STRATEGY_FPS[strategy];

  let requested: number;
  if (fps === null) {
    // Uniform keyframe proxy: ~1 frame every 2s, at least 1, never above the cap.
    requested = Math.max(1, Math.ceil(span / 2));
  } else {
    requested = Math.max(1, Math.ceil(span * fps));
  }

  const count = Math.min(requested, MAX_FRAMES);

  // Never seek to the duration itself: ffmpeg at EOF commonly returns no frame.
  // Cap every timestamp at `duration - EPSILON`, but keep it non-negative so a
  // sub-epsilon clip still samples a valid frame near the start.
  const maxT = Math.max(0, durationS - END_EPSILON_S);
  const cap = (t: number) => Math.min(maxT, t);

  const timestamps: number[] = [];
  if (count === 1) {
    timestamps.push(cap(windowStart + span / 2));
  } else {
    const step = span / (count - 1);
    for (let i = 0; i < count; i++) {
      timestamps.push(cap(windowStart + i * step));
    }
  }
  return { timestamps, requested };
}

/** Resolve a video attachment id to a readable on-disk path (or throws). */
async function materializeVideoPath(mediaRef: string): Promise<{
  path: string;
  cleanup: () => Promise<void>;
}> {
  const ref = mediaRef.trim();
  const row = getAttachmentById(ref);
  if (!row) {
    throw new VideoFramesError(`No attachment found for media_ref "${ref}".`);
  }

  const filePath = getFilePathForAttachment(ref);
  if (filePath) {
    return { path: filePath, cleanup: async () => {} };
  }

  // Inline-stored video: spill the base64 to a temp file ffmpeg can read.
  if (row.dataBase64) {
    const tmpPath = join(tmpdir(), `vellum-video-${randomUUID()}`);
    await writeFile(tmpPath, Buffer.from(row.dataBase64, "base64"));
    return {
      path: tmpPath,
      cleanup: async () => unlink(tmpPath).catch(() => {}),
    };
  }

  throw new VideoFramesError(
    `Attachment "${ref}" has no readable video content.`,
  );
}

/**
 * Sample timestamped keyframes from a video attachment. Throws
 * {@link VideoFramesError} on any failure (missing attachment, ffmpeg
 * unavailable, extraction failure) — the tool converts it to `{ isError: true }`.
 */
export async function sampleVideoFrames(
  mediaRef: string,
  options: SampleVideoOptions = {},
): Promise<SampledVideo> {
  const { path, cleanup } = await materializeVideoPath(mediaRef);
  try {
    const durationS = await probeDurationSeconds(path);

    const strategy = options.sample ?? "keyframes";
    const rawStart = options.window?.[0];
    const rawEnd = options.window?.[1];
    const hasWindow = rawStart !== undefined || rawEnd !== undefined;
    const windowStart = clampTime(rawStart ?? 0, 0, durationS);
    const windowEnd = clampTime(rawEnd ?? durationS, windowStart, durationS);

    const { timestamps, requested } = planTimestamps(
      durationS,
      windowStart,
      windowEnd,
      strategy,
    );

    const frames: SampledFrame[] = [];
    for (const t of timestamps) {
      if (options.signal?.aborted) {
        throw new VideoFramesError("Video frame sampling was cancelled.");
      }
      const base64 = await extractFrameAt(path, t);
      const optimized = optimizeImageForTransport(base64, "image/jpeg");
      frames.push({
        t_seconds: round1(t),
        block: toImageBlock(optimized),
      });
    }

    if (frames.length === 0) {
      throw new VideoFramesError("No frames could be sampled from the video.");
    }

    const result: SampledVideo = { duration_s: durationS, frames };

    const cappedByMax = requested > frames.length;
    if (cappedByMax || hasWindow) {
      const reasons: string[] = [];
      if (cappedByMax) {
        reasons.push(
          `frame count capped at ${MAX_FRAMES} (sampling asked for ${requested})`,
        );
      }
      if (hasWindow) {
        reasons.push(
          `sampling restricted to window [${windowStart.toFixed(1)}s, ${windowEnd.toFixed(1)}s] of a ${durationS.toFixed(1)}s clip`,
        );
      }
      result.truncated = {
        reason: reasons.join("; "),
        requested,
        returned: frames.length,
        covered_window: [round1(windowStart), round1(windowEnd)],
      };
    }

    return result;
  } catch (err) {
    if (err instanceof VideoFramesError) throw err;
    log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "video frame sampling failed",
    );
    throw new VideoFramesError(
      "Video frame sampling failed in this environment.",
    );
  } finally {
    await cleanup();
  }
}

function clampTime(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

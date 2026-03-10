/**
 * Clip generation tool — extract a video segment from a media asset.
 *
 * Uses ffmpeg to cut a segment with configurable pre/post-roll padding,
 * then registers the resulting clip as an attachment for in-chat delivery.
 * This is a generic media-processing primitive with no domain-specific logic.
 */

import { randomUUID } from "node:crypto";
import { access, constants, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { uploadFileBackedAttachment } from "../../../../memory/attachments-store.js";
import { getMediaAssetById } from "../../../../memory/media-store.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import {
  FFMPEG_CLIP_TIMEOUT_MS,
  FFPROBE_TIMEOUT_MS,
  spawnWithTimeout,
} from "../../../../util/spawn.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get the duration of a media file in seconds via ffprobe.
 */
async function getMediaDuration(filePath: string): Promise<number> {
  const result = await spawnWithTimeout(
    [
      "ffprobe",
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "csv=p=0",
      filePath,
    ],
    FFPROBE_TIMEOUT_MS,
  );
  if (result.exitCode !== 0) return 0;
  return parseFloat(result.stdout.trim()) || 0;
}

function formatTimestamp(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return `${hrs.toString().padStart(2, "0")}:${mins
    .toString()
    .padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

function sanitizeFilename(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 50) || "clip"
  );
}

const MIME_BY_FORMAT: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
};

const ALLOWED_OUTPUT_FORMATS = new Set(Object.keys(MIME_BY_FORMAT));

// ---------------------------------------------------------------------------
// Tool entry point
// ---------------------------------------------------------------------------

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const assetId = input.asset_id as string | undefined;
  if (!assetId) {
    return { content: "asset_id is required.", isError: true };
  }

  const startTime = input.start_time as number | undefined;
  if (startTime == null) {
    return { content: "start_time is required (seconds).", isError: true };
  }

  const endTime = input.end_time as number | undefined;
  if (endTime == null) {
    return { content: "end_time is required (seconds).", isError: true };
  }

  if (endTime <= startTime) {
    return {
      content: "end_time must be greater than start_time.",
      isError: true,
    };
  }

  const preRoll = (input.pre_roll as number) ?? 3;
  const postRoll = (input.post_roll as number) ?? 2;
  const outputFormatInput =
    typeof input.output_format === "string" ? input.output_format : "mp4";
  const outputFormat = outputFormatInput.toLowerCase();
  if (!ALLOWED_OUTPUT_FORMATS.has(outputFormat)) {
    return {
      content:
        "output_format must be one of: mp4, webm, mov (defaults to mp4).",
      isError: true,
    };
  }
  const title = input.title as string | undefined;

  const asset = getMediaAssetById(assetId);
  if (!asset) {
    return { content: `Media asset not found: ${assetId}`, isError: true };
  }

  if (asset.mediaType !== "video") {
    return {
      content: `Clip generation requires a video asset. Got: ${asset.mediaType}`,
      isError: true,
    };
  }

  // Get the file duration so we can clamp pre/post-roll to file boundaries
  const fileDuration =
    asset.durationSeconds ?? (await getMediaDuration(asset.filePath));

  // Calculate actual clip boundaries with pre/post-roll, clamped to file
  const clipStart = Math.max(0, startTime - preRoll);
  const clipEnd =
    fileDuration > 0
      ? Math.min(fileDuration, endTime + postRoll)
      : endTime + postRoll;
  const clipDuration = clipEnd - clipStart;

  // Save clips to the asset's pipeline directory so they persist for
  // attachment delivery (tmpdir files get cleaned up before the sandbox
  // attachment system can serve them). Fall back to a temp directory when the
  // source directory is read-only (external mounts, protected folders, etc.).
  const preferredDir = join(
    dirname(asset.filePath),
    "pipeline",
    assetId,
    "clips",
  );
  let clipDir: string;
  try {
    await mkdir(preferredDir, { recursive: true });
    await access(preferredDir, constants.W_OK);
    clipDir = preferredDir;
  } catch {
    clipDir = join(tmpdir(), "vellum-clips", assetId);
    await mkdir(clipDir, { recursive: true });
  }

  // Include a short unique suffix to prevent filename collisions when
  // concurrent or repeated calls target the same time range.
  const timestampSuffix = `${formatTimestamp(startTime).replace(/:/g, "")}-${formatTimestamp(endTime).replace(/:/g, "")}`;
  const uniqueSuffix = randomUUID().slice(0, 8);
  const clipFilename = title
    ? `${sanitizeFilename(title)}-${timestampSuffix}-${uniqueSuffix}.${outputFormat}`
    : `clip-${timestampSuffix}-${uniqueSuffix}.${outputFormat}`;
  const clipPath = join(clipDir, clipFilename);

  try {
    context.onOutput?.(
      `Extracting clip ${formatTimestamp(clipStart)} – ${formatTimestamp(
        clipEnd,
      )} from ${asset.title}...\n`,
    );

    // Use ffmpeg to extract the segment
    const ffmpegArgs = [
      "ffmpeg",
      "-y",
      "-ss",
      String(clipStart),
      "-i",
      asset.filePath,
      "-t",
      String(clipDuration),
      "-c",
      "copy",
      "-avoid_negative_ts",
      "make_zero",
      clipPath,
    ];

    const result = await spawnWithTimeout(ffmpegArgs, FFMPEG_CLIP_TIMEOUT_MS);

    if (result.exitCode !== 0) {
      // Stream copy failed — fall back to re-encoding (handles high-bitrate
      // sources, incompatible codecs, and missing keyframes at cut points)
      context.onOutput?.("Stream copy failed, re-encoding clip...\n");
      // Select codecs based on output format (WebM needs VP9/Opus, MP4/MOV use H.264/AAC)
      const codecArgs =
        outputFormat === "webm"
          ? [
              "-c:v",
              "libvpx-vp9",
              "-b:v",
              "2M",
              "-c:a",
              "libopus",
              "-b:a",
              "128k",
            ]
          : [
              "-c:v",
              "libx264",
              "-preset",
              "fast",
              "-crf",
              "23",
              "-c:a",
              "aac",
              "-b:a",
              "128k",
            ];
      const reencodeArgs = [
        "ffmpeg",
        "-y",
        "-ss",
        String(clipStart),
        "-i",
        asset.filePath,
        "-t",
        String(clipDuration),
        ...codecArgs,
        "-avoid_negative_ts",
        "make_zero",
        clipPath,
      ];
      const reencodeResult = await spawnWithTimeout(
        reencodeArgs,
        FFMPEG_CLIP_TIMEOUT_MS,
      );
      if (reencodeResult.exitCode !== 0) {
        return {
          content: `ffmpeg clip extraction failed (both stream copy and re-encode): ${reencodeResult.stderr.slice(0, 500)}`,
          isError: true,
        };
      }
    }

    // Verify the output file exists and has content
    const clipStat = await stat(clipPath);
    if (clipStat.size === 0) {
      return {
        content: "Clip extraction produced an empty file.",
        isError: true,
      };
    }

    context.onOutput?.(
      `Clip extracted (${(clipStat.size / 1024 / 1024).toFixed(
        1,
      )} MB). Registering as attachment...\n`,
    );

    // Register as file-backed attachment (no size limit, no base64 in-memory copy)
    const mimeType = MIME_BY_FORMAT[outputFormat] ?? "video/mp4";
    const attachment = uploadFileBackedAttachment(
      clipFilename,
      mimeType,
      clipPath,
      clipStat.size,
    );

    context.onOutput?.(`Clip registered as attachment ${attachment.id}.\n`);

    return {
      content: JSON.stringify(
        {
          message: `Clip extracted successfully`,
          attachmentId: attachment.id,
          filename: clipFilename,
          mimeType,
          sizeBytes: attachment.sizeBytes,
          clipStart,
          clipEnd,
          clipDuration,
          requestedRange: {
            startTime,
            endTime,
            preRoll,
            postRoll,
          },
          clipPath,
          assetId,
        },
        null,
        2,
      ),
      isError: false,
    };
  } catch (err) {
    return {
      content: `Clip generation failed: ${(err as Error).message}`,
      isError: true,
    };
  }
}

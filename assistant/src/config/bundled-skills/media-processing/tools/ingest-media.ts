import { access } from "node:fs/promises";
import { basename, extname } from "node:path";

import { enqueueMemoryJob } from "../../../../memory/jobs-store.js";
import {
  computeFileHashStreaming,
  createProcessingStage,
  getMediaAssetByHash,
  type MediaType,
  registerMediaAsset,
  updateMediaAssetStatus,
} from "../../../../memory/media-store.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import {
  FFPROBE_TIMEOUT_MS,
  spawnWithTimeout,
} from "../../../../util/spawn.js";

// ---------------------------------------------------------------------------
// MIME detection
// ---------------------------------------------------------------------------

const MIME_MAP: Record<string, string> = {
  // Video
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".m4v": "video/x-m4v",
  ".mpeg": "video/mpeg",
  ".mpg": "video/mpeg",
  ".ts": "video/mp2t",
  ".flv": "video/x-flv",
  ".wmv": "video/x-ms-wmv",
  // Audio
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/x-m4a",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".aiff": "audio/aiff",
  ".wma": "audio/x-ms-wma",
  // Image
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".tiff": "image/tiff",
  ".svg": "image/svg+xml",
  ".heic": "image/heic",
};

function detectMimeType(filePath: string): string | null {
  const ext = extname(filePath).toLowerCase();
  return MIME_MAP[ext] ?? null;
}

function classifyMediaType(mimeType: string): MediaType | null {
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("image/")) return "image";
  return null;
}

// ---------------------------------------------------------------------------
// ffprobe duration extraction
// ---------------------------------------------------------------------------

async function extractDuration(filePath: string): Promise<number | null> {
  try {
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
    if (result.exitCode !== 0) return null;
    const duration = parseFloat(result.stdout.trim());
    return Number.isFinite(duration) ? duration : null;
  } catch {
    // ffprobe not available or timed out
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const filePath = input.file_path as string | undefined;
  if (!filePath) {
    return {
      content:
        "file_path is required. Provide an absolute path to a local media file.",
      isError: true,
    };
  }

  // Validate file exists
  try {
    await access(filePath);
  } catch {
    return { content: `File not found: ${filePath}`, isError: true };
  }

  // Detect MIME type
  const mimeType = detectMimeType(filePath);
  if (!mimeType) {
    return {
      content: `Unsupported file type: ${extname(filePath)}. Supported: video (mp4, mov, avi, mkv, webm, etc.), audio (mp3, wav, m4a, etc.), image (png, jpg, gif, webp, etc.).`,
      isError: true,
    };
  }

  const mediaType = classifyMediaType(mimeType);
  if (!mediaType) {
    return {
      content: `Could not classify media type for MIME: ${mimeType}`,
      isError: true,
    };
  }

  // Compute content hash for dedup – streams the file in chunks so that
  // multi-GB video files don't cause OOM.
  context.onOutput?.("Computing content hash...\n");
  const fileHash = await computeFileHashStreaming(filePath);

  // Check for existing asset with same hash
  const existingAsset = getMediaAssetByHash(fileHash);
  if (existingAsset) {
    return {
      content: JSON.stringify(
        {
          message:
            "Media asset already registered (duplicate detected by content hash)",
          asset: existingAsset,
          deduplicated: true,
        },
        null,
        2,
      ),
      isError: false,
    };
  }

  // Extract duration for video/audio
  let durationSeconds: number | null = null;
  if (mediaType === "video" || mediaType === "audio") {
    context.onOutput?.("Extracting duration via ffprobe...\n");
    durationSeconds = await extractDuration(filePath);
  }

  // Determine title
  const title = (input.title as string) || basename(filePath);

  // Parse optional metadata
  let metadata: Record<string, unknown> | undefined;
  if (input.metadata && typeof input.metadata === "object") {
    metadata = input.metadata as Record<string, unknown>;
  }

  // Register the asset
  const asset = registerMediaAsset({
    title,
    filePath,
    mimeType,
    durationSeconds,
    fileHash,
    mediaType,
    metadata,
  });

  // Create an initial processing stage
  createProcessingStage({
    assetId: asset.id,
    stage: "ingest",
  });

  // Update status to processing
  updateMediaAssetStatus(asset.id, "processing");

  // Enqueue a processing job via the existing jobs framework
  enqueueMemoryJob("media_processing", {
    mediaAssetId: asset.id,
    stage: "ingest",
    filePath,
    mimeType,
    mediaType,
  });

  context.onOutput?.(`Registered media asset: ${asset.id}\n`);

  return {
    content: JSON.stringify(
      {
        message: "Media asset registered and processing enqueued",
        asset: {
          ...asset,
          status: "processing",
        },
        deduplicated: false,
      },
      null,
      2,
    ),
    isError: false,
  };
}

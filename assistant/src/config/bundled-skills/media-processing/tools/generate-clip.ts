/**
 * Clip generation tool — extract a video segment from a media asset.
 *
 * Uses ffmpeg to cut a segment with configurable pre/post-roll padding,
 * then registers the resulting clip as an attachment for in-chat delivery.
 * This is a generic media-processing primitive with no domain-specific logic.
 */

import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { mkdir, unlink, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { ToolContext, ToolExecutionResult } from '../../../../tools/types.js';
import { getMediaAssetById } from '../../../../memory/media-store.js';
import { uploadAttachment } from '../../../../memory/attachments-store.js';

const FFMPEG_TIMEOUT_MS = 300_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function spawnWithTimeout(
  cmd: string[],
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`Process timed out after ${timeoutMs}ms: ${cmd[0]}`));
    }, timeoutMs);
    proc.exited.then(async (exitCode) => {
      clearTimeout(timer);
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      resolve({ exitCode, stdout, stderr });
    });
  });
}

/**
 * Get the duration of a media file in seconds via ffprobe.
 */
async function getMediaDuration(filePath: string): Promise<number> {
  const result = await spawnWithTimeout([
    'ffprobe', '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'csv=p=0',
    filePath,
  ], 10_000);
  if (result.exitCode !== 0) return 0;
  return parseFloat(result.stdout.trim()) || 0;
}

function formatTimestamp(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

const MIME_BY_FORMAT: Record<string, string> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
};

// ---------------------------------------------------------------------------
// Tool entry point
// ---------------------------------------------------------------------------

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const assetId = input.asset_id as string | undefined;
  if (!assetId) {
    return { content: 'asset_id is required.', isError: true };
  }

  const startTime = input.start_time as number | undefined;
  if (startTime === undefined || startTime === null) {
    return { content: 'start_time is required (seconds).', isError: true };
  }

  const endTime = input.end_time as number | undefined;
  if (endTime === undefined || endTime === null) {
    return { content: 'end_time is required (seconds).', isError: true };
  }

  if (endTime <= startTime) {
    return { content: 'end_time must be greater than start_time.', isError: true };
  }

  const preRoll = (input.pre_roll as number) ?? 3;
  const postRoll = (input.post_roll as number) ?? 2;
  const outputFormat = (input.output_format as string) ?? 'mp4';

  const asset = getMediaAssetById(assetId);
  if (!asset) {
    return { content: `Media asset not found: ${assetId}`, isError: true };
  }

  if (asset.mediaType !== 'video') {
    return { content: `Clip generation requires a video asset. Got: ${asset.mediaType}`, isError: true };
  }

  // Get the file duration so we can clamp pre/post-roll to file boundaries
  const fileDuration = asset.durationSeconds ?? await getMediaDuration(asset.filePath);

  // Calculate actual clip boundaries with pre/post-roll, clamped to file
  const clipStart = Math.max(0, startTime - preRoll);
  const clipEnd = fileDuration > 0 ? Math.min(fileDuration, endTime + postRoll) : endTime + postRoll;
  const clipDuration = clipEnd - clipStart;

  // Prepare output path
  const clipDir = join(tmpdir(), `vellum-clips-${randomUUID()}`);
  await mkdir(clipDir, { recursive: true });

  const clipFilename = `clip-${formatTimestamp(startTime).replace(/:/g, '')}-${formatTimestamp(endTime).replace(/:/g, '')}.${outputFormat}`;
  const clipPath = join(clipDir, clipFilename);

  try {
    context.onOutput?.(`Extracting clip ${formatTimestamp(clipStart)} – ${formatTimestamp(clipEnd)} from ${asset.title}...\n`);

    // Use ffmpeg to extract the segment
    const ffmpegArgs = [
      'ffmpeg', '-y',
      '-ss', String(clipStart),
      '-i', asset.filePath,
      '-t', String(clipDuration),
      '-c', 'copy',
      '-avoid_negative_ts', 'make_zero',
      clipPath,
    ];

    const result = await spawnWithTimeout(ffmpegArgs, FFMPEG_TIMEOUT_MS);

    if (result.exitCode !== 0) {
      return {
        content: `ffmpeg clip extraction failed: ${result.stderr.slice(0, 500)}`,
        isError: true,
      };
    }

    // Verify the output file exists and has content
    const clipStat = await stat(clipPath);
    if (clipStat.size === 0) {
      return { content: 'Clip extraction produced an empty file.', isError: true };
    }

    context.onOutput?.(`Clip extracted (${(clipStat.size / 1024 / 1024).toFixed(1)} MB). Registering as attachment...\n`);

    // Read clip file and register as attachment
    const clipData = await readFile(clipPath);
    const clipBase64 = clipData.toString('base64');
    const mimeType = MIME_BY_FORMAT[outputFormat] ?? 'video/mp4';

    const attachment = uploadAttachment(clipFilename, mimeType, clipBase64);

    context.onOutput?.(`Clip registered as attachment ${attachment.id}.\n`);

    return {
      content: JSON.stringify({
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
        assetId,
      }, null, 2),
      isError: false,
    };
  } catch (err) {
    return {
      content: `Clip generation failed: ${(err as Error).message}`,
      isError: true,
    };
  } finally {
    // Clean up temp file
    try { await unlink(clipPath); } catch { /* ignore */ }
  }
}

/**
 * Extract a JPEG thumbnail from a video file using ffmpeg.
 *
 * Writes the video to a temp file, runs ffmpeg to extract the first frame
 * as a JPEG, and returns the result as a base64 string.
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { getLogger } from '../util/logger.js';

const log = getLogger('video-thumbnail');

/**
 * Generate a JPEG thumbnail from base64-encoded video data.
 * Returns null if ffmpeg is unavailable or extraction fails.
 */
export async function generateVideoThumbnail(dataBase64: string): Promise<string | null> {
  const id = randomUUID();
  const inputPath = join(tmpdir(), `vellum-thumb-in-${id}`);
  const outputPath = join(tmpdir(), `vellum-thumb-out-${id}.jpg`);

  try {
    const videoBuffer = Buffer.from(dataBase64, 'base64');
    writeFileSync(inputPath, videoBuffer);

    const proc = Bun.spawnSync([
      'ffmpeg', '-y',
      '-i', inputPath,
      '-vframes', '1',
      '-vf', 'scale=720:-2',
      '-q:v', '5',
      outputPath,
    ], { timeout: 10_000, stderr: 'pipe' });

    if (proc.exitCode !== 0) {
      log.warn({ exitCode: proc.exitCode }, 'ffmpeg thumbnail extraction failed');
      return null;
    }

    const jpegData = readFileSync(outputPath);
    return jpegData.toString('base64');
  } catch (err) {
    log.warn({ error: (err as Error).message }, 'Video thumbnail generation failed');
    return null;
  } finally {
    try { unlinkSync(inputPath); } catch { /* ignore */ }
    try { unlinkSync(outputPath); } catch { /* ignore */ }
  }
}

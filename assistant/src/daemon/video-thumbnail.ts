/**
 * Extract a JPEG thumbnail from a video file using ffmpeg.
 *
 * Writes the video to a temp file, runs ffmpeg to extract the first frame
 * as a JPEG, and returns the result as a base64 string.
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile, readFile, unlink } from 'node:fs/promises';
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
    await writeFile(inputPath, videoBuffer);

    const proc = Bun.spawn([
      'ffmpeg', '-y',
      '-i', inputPath,
      '-vframes', '1',
      '-vf', 'scale=720:-2',
      '-q:v', '5',
      outputPath,
    ], { stderr: 'pipe' });

    // Race against a 10s timeout to avoid hanging on slow/stuck ffmpeg.
    // The timer handle is cleared via finally() so it doesn't leak when ffmpeg exits normally.
    let timer: ReturnType<typeof setTimeout>;
    const exitCode = await Promise.race([
      proc.exited.finally(() => clearTimeout(timer)),
      new Promise<never>((_, reject) =>
        timer = setTimeout(() => { proc.kill(); reject(new Error('ffmpeg timed out')); }, 10_000)
      ),
    ]);

    if (exitCode !== 0) {
      log.warn({ exitCode }, 'ffmpeg thumbnail extraction failed');
      return null;
    }

    const jpegData = await readFile(outputPath);
    return jpegData.toString('base64');
  } catch (err) {
    log.warn({ error: (err as Error).message }, 'Video thumbnail generation failed');
    return null;
  } finally {
    try { await unlink(inputPath); } catch { /* ignore */ }
    try { await unlink(outputPath); } catch { /* ignore */ }
  }
}

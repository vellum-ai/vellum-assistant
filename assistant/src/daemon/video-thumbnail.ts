/**
 * Extract a JPEG thumbnail from a video file using ffmpeg.
 *
 * Two entry points:
 *  - `generateVideoThumbnail(base64)` — for in-memory video data
 *  - `generateVideoThumbnailFromPath(filePath)` — for file-backed videos (avoids
 *    loading the entire file into memory)
 */

import { randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getLogger } from "../util/logger.js";

const log = getLogger("video-thumbnail");

/** Run ffmpeg to extract the first frame from a video file as a JPEG thumbnail. */
async function extractThumbnail(inputPath: string): Promise<string | null> {
  const outputPath = join(tmpdir(), `vellum-thumb-out-${randomUUID()}.jpg`);

  try {
    const proc = Bun.spawn(
      [
        "ffmpeg",
        "-y",
        "-i",
        inputPath,
        "-vframes",
        "1",
        "-vf",
        "scale=720:-2",
        "-q:v",
        "5",
        outputPath,
      ],
      { stderr: "pipe" },
    );

    let timer: ReturnType<typeof setTimeout>;
    const exitCode = await Promise.race([
      proc.exited.finally(() => clearTimeout(timer)),
      new Promise<never>(
        (_, reject) =>
          (timer = setTimeout(() => {
            proc.kill();
            reject(new Error("ffmpeg timed out"));
          }, 10_000)),
      ),
    ]);

    if (exitCode !== 0) {
      log.warn({ exitCode }, "ffmpeg thumbnail extraction failed");
      return null;
    }

    const jpegData = await readFile(outputPath);
    return jpegData.toString("base64");
  } finally {
    try {
      await unlink(outputPath);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Generate a JPEG thumbnail from base64-encoded video data.
 * Returns null if ffmpeg is unavailable or extraction fails.
 */
export async function generateVideoThumbnail(
  dataBase64: string,
): Promise<string | null> {
  const inputPath = join(tmpdir(), `vellum-thumb-in-${randomUUID()}`);

  try {
    const videoBuffer = Buffer.from(dataBase64, "base64");
    await writeFile(inputPath, videoBuffer);
    return await extractThumbnail(inputPath);
  } catch (err) {
    log.warn(
      { error: (err as Error).message },
      "Video thumbnail generation failed",
    );
    return null;
  } finally {
    try {
      await unlink(inputPath);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Generate a JPEG thumbnail directly from a video file on disk.
 * Avoids loading the entire video into memory — suitable for large
 * file-backed recording attachments.
 * Returns null if ffmpeg is unavailable or extraction fails.
 */
export async function generateVideoThumbnailFromPath(
  filePath: string,
): Promise<string | null> {
  try {
    return await extractThumbnail(filePath);
  } catch (err) {
    log.warn(
      { error: (err as Error).message, filePath },
      "Video thumbnail generation from path failed",
    );
    return null;
  }
}

/**
 * Shared spawn-with-timeout helper used by media-processing and transcribe tools.
 */

/** Full video preprocessing: mpdecimate analysis, frame extraction, palette analysis. Longest operation. */
export const FFMPEG_PREPROCESS_TIMEOUT_MS = 600_000;

/** Clip extraction via stream copy. Moderate timeout — no re-encoding needed. */
export const FFMPEG_CLIP_TIMEOUT_MS = 300_000;

/** Audio transcoding/splitting to WAV for Whisper. Relatively fast operation. */
export const FFMPEG_TRANSCODE_TIMEOUT_MS = 120_000;

/** Metadata extraction via ffprobe. Very fast — just reads headers. */
export const FFPROBE_TIMEOUT_MS = 15_000;

export function spawnWithTimeout(
  cmd: string[],
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
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

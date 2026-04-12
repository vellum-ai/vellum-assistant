/**
 * Per-segment audio transcription for the video processing pipeline.
 * Extracts audio for a time range and transcribes it via the configured
 * STT service (resolved through `resolveBatchTranscriber`), returning the
 * transcript text.
 */

import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveBatchTranscriber } from "../../../../providers/speech-to-text/resolve.js";
import type { BatchTranscriber } from "../../../../stt/types.js";
import { spawnWithTimeout } from "../../../../util/spawn.js";

const FFMPEG_TIMEOUT_MS = 60_000;
const STT_REQUEST_TIMEOUT_MS = 120_000;

/**
 * Transcribe the audio from a specific time range of a video file.
 * Returns the transcript text, or empty string on failure (graceful degradation).
 *
 * Accepts an optional pre-resolved `BatchTranscriber` to avoid repeated
 * credential lookups when transcribing multiple segments in a loop. When
 * omitted, resolves the transcriber on demand via `resolveBatchTranscriber()`.
 *
 * Returns empty string when no provider is configured, the provider call
 * fails, or ffmpeg extraction fails — this preserves preprocess resilience.
 */
export async function transcribeSegmentAudio(
  videoPath: string,
  startSeconds: number,
  durationSeconds: number,
  transcriber?: BatchTranscriber | null,
): Promise<string> {
  const tmpWav = join(tmpdir(), `vellum-seg-audio-${randomUUID()}.wav`);

  try {
    // Use the provided transcriber or resolve on demand.
    // null = "already resolved, no provider"; only re-resolve when undefined (not passed).
    const resolved =
      transcriber === undefined ? await resolveBatchTranscriber() : transcriber;
    if (!resolved) {
      return "";
    }

    // Extract audio for the time range as 16kHz mono WAV
    const extractResult = await spawnWithTimeout(
      [
        "ffmpeg",
        "-y",
        "-ss",
        String(startSeconds),
        "-t",
        String(durationSeconds),
        "-i",
        videoPath,
        "-vn",
        "-acodec",
        "pcm_s16le",
        "-ar",
        "16000",
        "-ac",
        "1",
        tmpWav,
      ],
      FFMPEG_TIMEOUT_MS,
    );

    if (extractResult.exitCode !== 0) {
      return "";
    }

    // Send extracted WAV through the provider-agnostic transcriber
    const audioBuffer = await readFile(tmpWav);
    const result = await resolved.transcribe({
      audio: audioBuffer,
      mimeType: "audio/wav",
      signal: AbortSignal.timeout(STT_REQUEST_TIMEOUT_MS),
    });

    return result.text?.trim() ?? "";
  } catch {
    return "";
  } finally {
    try {
      await unlink(tmpWav);
    } catch {
      /* ignore */
    }
  }
}

import { randomUUID } from "node:crypto";
import { access, mkdir, readdir, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

import { resolveBatchTranscriber } from "../../../../providers/speech-to-text/resolve.js";
import type { BatchTranscriber } from "../../../../stt/types.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { silentlyWithLog } from "../../../../util/silently.js";
import {
  FFMPEG_TRANSCODE_TIMEOUT_MS,
  FFPROBE_TIMEOUT_MS,
  spawnWithTimeout,
} from "../../../../util/spawn.js";

const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".avi",
  ".mkv",
  ".webm",
  ".m4v",
  ".mpeg",
  ".mpg",
]);
const AUDIO_EXTENSIONS = new Set([
  ".mp3",
  ".wav",
  ".m4a",
  ".aac",
  ".ogg",
  ".flac",
  ".aiff",
  ".wma",
]);

/** Max file size for a single STT chunk request (25MB). */
const STT_CHUNK_MAX_BYTES = 25 * 1024 * 1024;

/** Duration per chunk when splitting for large files (10 minutes - stays well under 25MB as WAV). */
const CHUNK_DURATION_SECS = 600;

/** Timeout for a single STT transcription request. */
const STT_REQUEST_TIMEOUT_MS = 300_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getAudioDuration(audioPath: string): Promise<number> {
  const result = await spawnWithTimeout(
    [
      "ffprobe",
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "csv=p=0",
      audioPath,
    ],
    FFPROBE_TIMEOUT_MS,
  );
  if (result.exitCode !== 0) return 0;
  return parseFloat(result.stdout.trim()) || 0;
}

async function splitAudio(
  audioPath: string,
  chunkDir: string,
  chunkDurationSecs: number,
): Promise<string[]> {
  const chunkPattern = join(chunkDir, "chunk-%03d.wav");
  const result = await spawnWithTimeout(
    [
      "ffmpeg",
      "-y",
      "-i",
      audioPath,
      "-f",
      "segment",
      "-segment_time",
      String(chunkDurationSecs),
      "-acodec",
      "pcm_s16le",
      "-ar",
      "16000",
      "-ac",
      "1",
      chunkPattern,
    ],
    FFMPEG_TRANSCODE_TIMEOUT_MS,
  );
  if (result.exitCode !== 0) {
    throw new Error(`Failed to split audio: ${result.stderr.slice(0, 300)}`);
  }
  const files = await readdir(chunkDir);
  return files
    .filter((f) => f.startsWith("chunk-") && f.endsWith(".wav"))
    .sort()
    .map((f) => join(chunkDir, f));
}

// ---------------------------------------------------------------------------
// Source resolution
// ---------------------------------------------------------------------------

async function resolveSource(
  input: Record<string, unknown>,
): Promise<{ inputPath: string; isVideo: boolean } | ToolExecutionResult> {
  const filePath = input.file_path as string | undefined;

  if (!filePath) {
    return {
      content: "Provide a file_path to the audio or video file to transcribe.",
      isError: true,
    };
  }

  try {
    await access(filePath);
  } catch {
    return { content: `File not found: ${filePath}`, isError: true };
  }
  const ext = extname(filePath).toLowerCase();
  const isVideo = VIDEO_EXTENSIONS.has(ext);
  const isAudio = AUDIO_EXTENSIONS.has(ext);
  if (!isVideo && !isAudio) {
    return {
      content: `Unsupported file type: ${ext}. Only video and audio files can be transcribed.`,
      isError: true,
    };
  }
  return { inputPath: filePath, isVideo };
}

/** Convert source to 16kHz mono WAV for consistent processing. */
async function toWav(inputPath: string, isVideo: boolean): Promise<string> {
  const wavPath = join(tmpdir(), `vellum-transcribe-${randomUUID()}.wav`);
  const args = ["ffmpeg", "-y", "-i", inputPath];
  if (isVideo) args.push("-vn");
  args.push("-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1", wavPath);
  const result = await spawnWithTimeout(args, FFMPEG_TRANSCODE_TIMEOUT_MS);
  if (result.exitCode !== 0) {
    throw new Error(`ffmpeg failed: ${result.stderr.slice(0, 500)}`);
  }
  return wavPath;
}

// ---------------------------------------------------------------------------
// Transcription via resolved STT provider
// ---------------------------------------------------------------------------

async function transcribeWithProvider(
  audioPath: string,
  transcriber: BatchTranscriber,
  context: ToolContext,
): Promise<string> {
  const duration = await getAudioDuration(audioPath);
  const fileSize = Bun.file(audioPath).size;

  // If small enough, send directly
  if (fileSize <= STT_CHUNK_MAX_BYTES) {
    const audioBuffer = await readFile(audioPath);
    const result = await transcriber.transcribe({
      audio: audioBuffer,
      mimeType: "audio/wav",
      signal: AbortSignal.timeout(STT_REQUEST_TIMEOUT_MS),
    });
    return result.text;
  }

  // Split into chunks for large files
  const chunkDir = join(tmpdir(), `vellum-transcribe-chunks-${randomUUID()}`);
  await mkdir(chunkDir, { recursive: true });

  try {
    context.onOutput?.(
      `Large file (${Math.round(
        duration / 60,
      )}min) - splitting into chunks...\n`,
    );
    const chunks = await splitAudio(audioPath, chunkDir, CHUNK_DURATION_SECS);
    const parts: string[] = [];

    for (let i = 0; i < chunks.length; i++) {
      if (context.signal?.aborted) throw new Error("Cancelled");
      context.onOutput?.(`  Transcribing chunk ${i + 1}/${chunks.length}...\n`);
      const audioBuffer = await readFile(chunks[i]);
      const result = await transcriber.transcribe({
        audio: audioBuffer,
        mimeType: "audio/wav",
        signal: AbortSignal.timeout(STT_REQUEST_TIMEOUT_MS),
      });
      if (result.text) parts.push(result.text);
    }

    return parts.join(" ");
  } finally {
    const { rm } = await import("node:fs/promises");
    await silentlyWithLog(
      rm(chunkDir, { recursive: true, force: true }),
      "transcribe chunk cleanup",
    );
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  // Reject legacy callers that pass the now-removed `mode` parameter to avoid
  // silently routing audio through a different provider than expected.
  if ("mode" in input) {
    return {
      content:
        "The `mode` parameter is no longer supported. Transcription now uses the configured speech-to-text service.",
      isError: true,
    };
  }

  // Resolve the configured STT provider
  const transcriber = await resolveBatchTranscriber();
  if (!transcriber) {
    return {
      content:
        "No speech-to-text provider is configured. Set up an STT provider (e.g. OpenAI Whisper or Deepgram) in your assistant settings to enable transcription.",
      isError: true,
    };
  }

  const source = await resolveSource(input);
  if ("isError" in source) return source;

  const { inputPath, isVideo } = source;
  let wavPath: string | null = null;

  try {
    // Convert to WAV
    wavPath = await toWav(inputPath, isVideo);

    const text = await transcribeWithProvider(wavPath, transcriber, context);

    if (!text.trim()) {
      return { content: "No speech detected in the audio.", isError: false };
    }

    return { content: text, isError: false };
  } catch (err) {
    return {
      content: `Transcription failed: ${(err as Error).message}`,
      isError: true,
    };
  } finally {
    if (wavPath) {
      try {
        await unlink(wavPath);
      } catch {
        /* ignore */
      }
    }
  }
}

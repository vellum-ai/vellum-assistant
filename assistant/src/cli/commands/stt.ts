/**
 * CLI command group: `assistant stt`
 *
 * Speech-to-text operations using the configured STT provider.
 * Stateless, request-response commands — no daemon dependency.
 */

import { randomUUID } from "node:crypto";
import { access, mkdir, readdir, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

import type { Command } from "commander";

import { resolveBatchTranscriber } from "../../providers/speech-to-text/resolve.js";
import type { BatchTranscriber } from "../../stt/types.js";
import {
  FFMPEG_TRANSCODE_TIMEOUT_MS,
  FFPROBE_TIMEOUT_MS,
  spawnWithTimeout,
} from "../../util/spawn.js";
import { log } from "../logger.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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

/** Duration per chunk when splitting for large files (10 minutes). */
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

async function transcribeWithProvider(
  audioPath: string,
  transcriber: BatchTranscriber,
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
    process.stderr.write(
      `Large file (${Math.round(duration / 60)}min) - splitting into chunks...\n`,
    );
    const chunks = await splitAudio(audioPath, chunkDir, CHUNK_DURATION_SECS);
    const parts: string[] = [];

    for (let i = 0; i < chunks.length; i++) {
      process.stderr.write(
        `  Transcribing chunk ${i + 1}/${chunks.length}...\n`,
      );
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
    await rm(chunkDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerSttCommand(program: Command): void {
  const sttCmd = program
    .command("stt")
    .description("Speech-to-text operations");

  sttCmd.addHelpText(
    "after",
    `
Speech-to-text commands use your configured STT provider to transcribe
audio and video files. The provider is set via:

  $ assistant config set services.stt.provider <provider>

Supported providers include openai-whisper, deepgram, and google-gemini.

Examples:
  $ assistant stt transcribe --file /path/to/meeting.wav
  $ assistant stt transcribe --file /path/to/video.mp4 --json`,
  );

  // ── transcribe ──────────────────────────────────────────────────────

  sttCmd
    .command("transcribe")
    .description("Transcribe an audio or video file to text")
    .requiredOption("--file <path>", "Absolute path to the audio/video file")
    .option("--json", "Output structured JSON instead of plain transcript text")
    .addHelpText(
      "after",
      `
Transcribes an audio or video file using the configured speech-to-text
provider. Video files automatically have their audio extracted via ffmpeg.
Large files (>25MB as WAV) are automatically split into chunks and
transcribed sequentially.

Supported audio formats: .mp3, .wav, .m4a, .aac, .ogg, .flac, .aiff, .wma
Supported video formats: .mp4, .mov, .avi, .mkv, .webm, .m4v, .mpeg, .mpg

Requires ffmpeg and ffprobe to be installed and on PATH.

Examples:
  $ assistant stt transcribe --file /path/to/recording.wav
  $ assistant stt transcribe --file /path/to/meeting.mp4
  $ assistant stt transcribe --file /path/to/podcast.mp3 --json`,
    )
    .action(async (opts: { file: string; json?: boolean }) => {
      const filePath = opts.file;
      const jsonOutput = opts.json ?? false;

      // Validate file exists
      try {
        await access(filePath);
      } catch {
        const msg = `File not found: ${filePath}`;
        if (jsonOutput) {
          process.stdout.write(
            JSON.stringify({ ok: false, error: msg }) + "\n",
          );
        } else {
          log.error(msg);
        }
        process.exitCode = 1;
        return;
      }

      // Validate file extension
      const ext = extname(filePath).toLowerCase();
      const isVideo = VIDEO_EXTENSIONS.has(ext);
      const isAudio = AUDIO_EXTENSIONS.has(ext);
      if (!isVideo && !isAudio) {
        const msg = `Unsupported file type: ${ext}. Only audio and video files can be transcribed.`;
        if (jsonOutput) {
          process.stdout.write(
            JSON.stringify({ ok: false, error: msg }) + "\n",
          );
        } else {
          log.error(msg);
        }
        process.exitCode = 1;
        return;
      }

      // Resolve STT provider
      const transcriber = await resolveBatchTranscriber();
      if (!transcriber) {
        const msg =
          "No speech-to-text provider is configured. Run 'assistant config set services.stt.provider <provider>' to set one up.";
        if (jsonOutput) {
          process.stdout.write(
            JSON.stringify({ ok: false, error: msg }) + "\n",
          );
        } else {
          log.error(msg);
        }
        process.exitCode = 1;
        return;
      }

      let wavPath: string | null = null;
      try {
        // Convert to WAV
        wavPath = await toWav(filePath, isVideo);

        const startTime = Date.now();
        const text = await transcribeWithProvider(wavPath, transcriber);
        const durationSeconds = (Date.now() - startTime) / 1000;

        if (!text.trim()) {
          if (jsonOutput) {
            process.stdout.write(
              JSON.stringify({
                transcript: "",
                provider: transcriber.providerId,
                durationSeconds,
              }) + "\n",
            );
          } else {
            process.stdout.write("No speech detected in the audio.\n");
          }
          return;
        }

        if (jsonOutput) {
          process.stdout.write(
            JSON.stringify({
              transcript: text,
              provider: transcriber.providerId,
              durationSeconds,
            }) + "\n",
          );
        } else {
          process.stdout.write(text + "\n");
        }
      } catch (err) {
        const msg = `Transcription failed: ${(err as Error).message}`;
        if (jsonOutput) {
          process.stdout.write(
            JSON.stringify({ ok: false, error: msg }) + "\n",
          );
        } else {
          log.error(msg);
        }
        process.exitCode = 1;
      } finally {
        if (wavPath) {
          try {
            await unlink(wavPath);
          } catch {
            /* ignore */
          }
        }
      }
    });
}

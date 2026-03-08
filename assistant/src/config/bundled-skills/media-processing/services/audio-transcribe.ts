/**
 * Per-segment audio transcription for the video processing pipeline.
 * Extracts audio for a time range and transcribes it via OpenAI Whisper API
 * or local whisper.cpp, returning the transcript text.
 */

import { randomUUID } from "node:crypto";
import { access, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spawnWithTimeout } from "../../../../util/spawn.js";

const FFMPEG_TIMEOUT_MS = 60_000;
const API_REQUEST_TIMEOUT_MS = 120_000;
const LOCAL_CHUNK_TIMEOUT_MS = 120_000;

/**
 * Transcribe the audio from a specific time range of a video file.
 * Returns the transcript text, or empty string on failure (graceful degradation).
 */
export async function transcribeSegmentAudio(
  videoPath: string,
  startSeconds: number,
  durationSeconds: number,
  mode: "api" | "local",
  options?: { apiKey?: string },
): Promise<string> {
  const tmpWav = join(tmpdir(), `vellum-seg-audio-${randomUUID()}.wav`);

  try {
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

    if (mode === "api") {
      return await transcribeViaApi(tmpWav, options?.apiKey);
    }
    return await transcribeViaLocal(tmpWav);
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

async function transcribeViaApi(
  audioPath: string,
  apiKey?: string,
): Promise<string> {
  if (!apiKey) return "";

  const audioData = await readFile(audioPath);
  const formData = new FormData();
  formData.append(
    "file",
    new Blob([audioData], { type: "audio/wav" }),
    "audio.wav",
  );
  formData.append("model", "whisper-1");

  const response = await fetch(
    "https://api.openai.com/v1/audio/transcriptions",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
      signal: AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
    },
  );

  if (!response.ok) return "";

  const result = (await response.json()) as { text?: string };
  return result.text?.trim() ?? "";
}

async function transcribeViaLocal(audioPath: string): Promise<string> {
  // Check if whisper-cpp is available
  const whichResult = await spawnWithTimeout(["which", "whisper-cpp"], 5_000);
  if (whichResult.exitCode !== 0) return "";

  // Resolve model path
  const modelPath = await resolveWhisperModel();
  if (!modelPath) return "";

  const result = await spawnWithTimeout(
    ["whisper-cpp", "-m", modelPath, "-f", audioPath, "--no-timestamps"],
    LOCAL_CHUNK_TIMEOUT_MS,
  );

  if (result.exitCode !== 0) return "";

  return result.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join(" ")
    .trim();
}

async function resolveWhisperModel(): Promise<string | null> {
  const homeDir = process.env.HOME ?? "/tmp";
  const candidates = [
    join(homeDir, ".vellum", "models", "ggml-base.en.bin"),
    join(homeDir, ".vellum", "models", "ggml-base.bin"),
    "/usr/local/share/whisper-cpp/models/ggml-base.en.bin",
    "/opt/homebrew/share/whisper-cpp/models/ggml-base.en.bin",
  ];

  for (const p of candidates) {
    try {
      await access(p);
      return p;
    } catch {
      /* next */
    }
  }

  return null;
}

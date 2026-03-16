import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readdir,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

import {
  getAttachmentsByIds,
  getFilePathForAttachment,
} from "../../../../memory/attachments-store.js";
import { getSecureKeyAsync } from "../../../../security/secure-keys.js";
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

/** Max file size for a single OpenAI Whisper API request (25MB). */
const WHISPER_API_MAX_BYTES = 25 * 1024 * 1024;

/** Duration per chunk when splitting for the API (10 minutes — stays well under 25MB as WAV). */
const API_CHUNK_DURATION_SECS = 600;

/** Timeout for a single Whisper API request. */
const API_REQUEST_TIMEOUT_MS = 300_000;

/** Timeout for a single whisper.cpp chunk transcription. */
const LOCAL_CHUNK_TIMEOUT_MS = 600_000;

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
): Promise<
  | { inputPath: string; isVideo: boolean; tempFile: string | null }
  | ToolExecutionResult
> {
  const filePath = input.file_path as string | undefined;
  const attachmentId = input.attachment_id as string | undefined;

  if (filePath) {
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
    return { inputPath: filePath, isVideo, tempFile: null };
  }

  if (attachmentId) {
    const attachments = getAttachmentsByIds([attachmentId]);
    if (attachments.length === 0) {
      return {
        content: `Attachment not found: ${attachmentId}`,
        isError: true,
      };
    }
    const attachment = attachments[0];
    const mime = attachment.mimeType;
    if (!mime.startsWith("video/") && !mime.startsWith("audio/")) {
      return {
        content: `Unsupported file type: ${mime}. Only video and audio files can be transcribed.`,
        isError: true,
      };
    }
    // Check if this is a file-backed attachment (large files stored on disk)
    const onDiskPath = getFilePathForAttachment(attachment.id);
    if (onDiskPath) {
      // File-backed attachment — use the on-disk file directly
      try {
        await access(onDiskPath);
      } catch {
        return {
          content: `Attachment file not found on disk: ${onDiskPath}`,
          isError: true,
        };
      }
      return {
        inputPath: onDiskPath,
        isVideo: mime.startsWith("video/"),
        tempFile: null,
      };
    }

    // Inline attachment — decode base64 to a temp file
    const ext = mime.startsWith("video/") ? ".mp4" : ".m4a";
    const tempPath = join(
      tmpdir(),
      `vellum-transcribe-in-${randomUUID()}${ext}`,
    );
    await writeFile(tempPath, Buffer.from(attachment.dataBase64, "base64"));
    return {
      inputPath: tempPath,
      isVideo: mime.startsWith("video/"),
      tempFile: tempPath,
    };
  }

  return {
    content: "Provide either file_path or attachment_id.",
    isError: true,
  };
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
// API mode — OpenAI Whisper API
// ---------------------------------------------------------------------------

async function transcribeViaApi(
  audioPath: string,
  apiKey: string,
  context: ToolContext,
): Promise<string> {
  const duration = await getAudioDuration(audioPath);
  const fileSize = Bun.file(audioPath).size;

  // If small enough, send directly
  if (fileSize <= WHISPER_API_MAX_BYTES) {
    return await whisperApiRequest(audioPath, apiKey);
  }

  // Split into chunks for large files
  const chunkDir = join(
    tmpdir(),
    `vellum-transcribe-api-chunks-${randomUUID()}`,
  );
  await mkdir(chunkDir, { recursive: true });

  try {
    context.onOutput?.(
      `Large file (${Math.round(
        duration / 60,
      )}min) — splitting into chunks...\n`,
    );
    const chunks = await splitAudio(
      audioPath,
      chunkDir,
      API_CHUNK_DURATION_SECS,
    );
    const parts: string[] = [];

    for (let i = 0; i < chunks.length; i++) {
      if (context.signal?.aborted) throw new Error("Cancelled");
      context.onOutput?.(`  Transcribing chunk ${i + 1}/${chunks.length}...\n`);
      const text = await whisperApiRequest(chunks[i], apiKey);
      if (text) parts.push(text);
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

async function whisperApiRequest(
  audioPath: string,
  apiKey: string,
): Promise<string> {
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

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Whisper API error (${response.status}): ${body.slice(0, 300)}`,
    );
  }

  const result = (await response.json()) as { text?: string };
  return result.text?.trim() ?? "";
}

// ---------------------------------------------------------------------------
// Local mode — whisper.cpp
// ---------------------------------------------------------------------------

async function transcribeViaLocal(
  audioPath: string,
  context: ToolContext,
): Promise<string> {
  // Check if whisper-cpp is installed
  const whichResult = await spawnWithTimeout(["which", "whisper-cpp"], 5_000);
  if (whichResult.exitCode !== 0) {
    throw new Error(
      "whisper-cpp is not installed. Install it with: brew install whisper-cpp",
    );
  }

  // Resolve model path — use the base model, download if needed
  const modelPath = await resolveWhisperModel(context);

  const duration = await getAudioDuration(audioPath);

  if (duration > 0 && duration <= 1800) {
    // Under 30 minutes — transcribe directly (whisper.cpp handles long files well)
    context.onOutput?.(
      `Transcribing ${Math.round(duration / 60)}min of audio locally...\n`,
    );
    return await whisperCppRun(audioPath, modelPath);
  }

  // Very long files — split into 10-minute chunks to show progress
  const chunkDir = join(
    tmpdir(),
    `vellum-transcribe-local-chunks-${randomUUID()}`,
  );
  await mkdir(chunkDir, { recursive: true });

  try {
    context.onOutput?.(
      `Large file (${Math.round(
        duration / 60,
      )}min) — splitting into chunks...\n`,
    );
    const chunks = await splitAudio(audioPath, chunkDir, 600);
    const parts: string[] = [];

    for (let i = 0; i < chunks.length; i++) {
      if (context.signal?.aborted) throw new Error("Cancelled");
      context.onOutput?.(`  Transcribing chunk ${i + 1}/${chunks.length}...\n`);
      const text = await whisperCppRun(chunks[i], modelPath);
      if (text) parts.push(text);
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

async function resolveWhisperModel(context: ToolContext): Promise<string> {
  // Check common locations for the base model
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

  // Download the base.en model (~140MB)
  const modelDir = join(homeDir, ".vellum", "models");
  await mkdir(modelDir, { recursive: true });
  const modelPath = join(modelDir, "ggml-base.en.bin");
  const modelUrl =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin";

  context.onOutput?.("Downloading Whisper base.en model (~140MB)...\n");

  const response = await fetch(modelUrl);
  if (!response.ok) {
    throw new Error(`Failed to download model: ${response.status}`);
  }

  const data = Buffer.from(await response.arrayBuffer());
  await writeFile(modelPath, data);
  context.onOutput?.("Model downloaded.\n");

  return modelPath;
}

async function whisperCppRun(
  audioPath: string,
  modelPath: string,
): Promise<string> {
  const result = await spawnWithTimeout(
    ["whisper-cpp", "-m", modelPath, "-f", audioPath, "--no-timestamps"],
    LOCAL_CHUNK_TIMEOUT_MS,
  );

  if (result.exitCode !== 0) {
    throw new Error(`whisper-cpp failed: ${result.stderr.slice(0, 300)}`);
  }

  // whisper-cpp outputs transcription to stderr with some logging, and
  // the actual text lines to stdout. Clean up whitespace.
  return result.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join(" ")
    .trim();
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const mode = input.mode as "api" | "local";
  if (!mode || (mode !== "api" && mode !== "local")) {
    return {
      content:
        "Please specify mode: 'api' (OpenAI cloud) or 'local' (whisper.cpp on-device). Ask the user which they prefer.",
      isError: true,
    };
  }

  // Validate API key for api mode
  let openaiKey: string | undefined;
  if (mode === "api") {
    openaiKey =
      (await getSecureKeyAsync("openai")) ?? process.env.OPENAI_API_KEY;
    if (!openaiKey) {
      return {
        content:
          'No OpenAI API key configured. Set your OpenAI API key to use cloud transcription, or use mode "local" for on-device transcription with whisper.cpp.',
        isError: true,
      };
    }
  }

  const source = await resolveSource(input);
  if ("isError" in source) return source;

  const { inputPath, isVideo, tempFile } = source;
  let wavPath: string | null = null;

  try {
    // Convert to WAV
    wavPath = await toWav(inputPath, isVideo);

    let text: string;
    if (mode === "api") {
      text = await transcribeViaApi(wavPath, openaiKey!, context);
    } else {
      text = await transcribeViaLocal(wavPath, context);
    }

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
    if (tempFile) {
      try {
        await unlink(tempFile);
      } catch {
        /* ignore */
      }
    }
    if (wavPath) {
      try {
        await unlink(wavPath);
      } catch {
        /* ignore */
      }
    }
  }
}

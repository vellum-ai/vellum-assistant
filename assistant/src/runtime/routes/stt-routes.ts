/**
 * Transport-agnostic route definitions for speech-to-text.
 *
 * GET  /v1/stt/providers        — list available STT providers and their metadata
 * POST /v1/stt/transcribe       — transcribe base64-encoded audio to text
 * POST /v1/stt/transcribe-file  — transcribe audio/video file to text (full ffmpeg + chunking flow)
 */

import { randomUUID } from "node:crypto";
import { access, mkdir, readdir, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

import { z } from "zod";

import { listProviderEntries } from "../../providers/speech-to-text/provider-catalog.js";
import { resolveBatchTranscriber } from "../../providers/speech-to-text/resolve.js";
import { normalizeSttError } from "../../stt/daemon-batch-transcriber.js";
import type { BatchTranscriber, SttErrorCategory } from "../../stt/types.js";
import { SttError } from "../../stt/types.js";
import { getLogger } from "../../util/logger.js";
import {
  FFMPEG_TRANSCODE_TIMEOUT_MS,
  FFPROBE_TIMEOUT_MS,
  spawnWithTimeout,
} from "../../util/spawn.js";
import { ACTOR_PRINCIPALS, LOCAL_PRINCIPALS } from "../auth/route-policy.js";
import {
  BadGatewayError,
  BadRequestError,
  GatewayTimeoutError,
  type RouteError,
  ServiceUnavailableError,
  TooManyRequestsError,
  UnauthorizedError,
} from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("stt-routes");

/** Timeout for a single transcription request. */
const TRANSCRIPTION_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// File-transcription constants and helpers (used by stt_transcribe_file)
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

/**
 * Call the provider and tag any failure as an {@link SttError} so callers can
 * distinguish provider failures (categorized HTTP statuses) from local
 * preprocessing failures (ffmpeg/ffprobe), which stay on the bad-gateway path.
 */
async function transcribeChunk(
  transcriber: BatchTranscriber,
  audioBuffer: Buffer,
): Promise<string> {
  try {
    const result = await transcriber.transcribe({
      audio: audioBuffer,
      mimeType: "audio/wav",
      signal: AbortSignal.timeout(STT_REQUEST_TIMEOUT_MS),
    });
    return result.text;
  } catch (err) {
    throw normalizeSttError(err);
  }
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
    return transcribeChunk(transcriber, audioBuffer);
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
      const text = await transcribeChunk(transcriber, audioBuffer);
      if (text) parts.push(text);
    }

    return parts.join(" ");
  } finally {
    await rm(chunkDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Error category → RouteError mapping
// ---------------------------------------------------------------------------

const STT_ERROR_MAP: Record<SttErrorCategory, () => RouteError> = {
  auth: () =>
    new UnauthorizedError("STT provider credentials are invalid or missing"),
  "rate-limit": () =>
    new TooManyRequestsError("STT provider rate limit exceeded"),
  timeout: () => new GatewayTimeoutError("STT transcription timed out"),
  "invalid-audio": () =>
    new BadRequestError("Audio payload was rejected by the STT provider"),
  "provider-error": () => new BadGatewayError("STT provider error"),
};

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function handleListProviders() {
  const entries = listProviderEntries();
  const providers = entries.map((e) => ({
    id: e.id,
    displayName: e.displayName,
    subtitle: e.subtitle,
    setupMode: e.setupMode,
    setupHint: e.setupHint,
    apiKeyProviderName: e.credentialProvider,
    conversationStreamingMode: e.conversationStreamingMode,
    credentialsGuide: e.credentialsGuide,
  }));
  return { providers };
}

async function handleTranscribe({ body }: RouteHandlerArgs) {
  // -- Validate audioBase64 -------------------------------------------------
  if (
    !body?.audioBase64 ||
    typeof body.audioBase64 !== "string" ||
    body.audioBase64.length === 0
  ) {
    throw new BadRequestError(
      "audioBase64 is required and must be a non-empty string",
    );
  }

  // -- Validate mimeType ----------------------------------------------------
  if (
    !body.mimeType ||
    typeof body.mimeType !== "string" ||
    !body.mimeType.startsWith("audio/")
  ) {
    throw new BadRequestError(
      'mimeType is required and must start with "audio/"',
    );
  }

  // -- Decode audio ---------------------------------------------------------
  const base64Str = body.audioBase64 as string;
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      base64Str,
    )
  ) {
    throw new BadRequestError("Invalid base64 encoding in audioBase64");
  }

  let audioBuffer: Buffer;
  try {
    audioBuffer = Buffer.from(base64Str, "base64");
  } catch {
    throw new BadRequestError("audioBase64 could not be decoded");
  }

  if (audioBuffer.length === 0) {
    throw new BadRequestError("Decoded audio payload is empty");
  }

  // -- Resolve transcriber --------------------------------------------------
  let transcriber;
  try {
    transcriber = await resolveBatchTranscriber();
  } catch (err) {
    log.error({ err }, "Failed to resolve STT transcriber");
    throw new ServiceUnavailableError("STT provider is not available");
  }

  if (!transcriber) {
    throw new ServiceUnavailableError(
      "No speech-to-text provider is configured",
    );
  }

  // -- Transcribe with timeout ----------------------------------------------
  const abortController = new AbortController();
  const timeoutId = setTimeout(
    () => abortController.abort(),
    TRANSCRIPTION_TIMEOUT_MS,
  );

  try {
    const result = await transcriber.transcribe({
      audio: audioBuffer,
      mimeType: body.mimeType as string,
      signal: abortController.signal,
    });

    return {
      text: result.text,
      providerId: transcriber.providerId,
      boundaryId: transcriber.boundaryId,
    };
  } catch (err) {
    const sttErr = normalizeSttError(err);
    log.warn(
      {
        category: sttErr.category,
        message: sttErr.message,
        source: body.source,
      },
      "STT transcription failed",
    );
    throw STT_ERROR_MAP[sttErr.category]();
  } finally {
    clearTimeout(timeoutId);
  }
}

async function handleTranscribeFile({ body }: RouteHandlerArgs) {
  const filePath = body?.filePath;
  if (typeof filePath !== "string" || !filePath) {
    throw new BadRequestError("filePath is required");
  }

  try {
    await access(filePath);
  } catch {
    throw new BadRequestError(`File not found: ${filePath}`);
  }

  const ext = extname(filePath).toLowerCase();
  const isVideo = VIDEO_EXTENSIONS.has(ext);
  const isAudio = AUDIO_EXTENSIONS.has(ext);
  if (!isVideo && !isAudio) {
    throw new BadRequestError(
      `Unsupported file type: ${ext}. Only audio and video files can be transcribed.`,
    );
  }

  let transcriber;
  try {
    transcriber = await resolveBatchTranscriber();
  } catch (err) {
    log.error({ err }, "Failed to resolve STT transcriber");
    throw new ServiceUnavailableError("STT provider is not available");
  }
  if (!transcriber) {
    throw new ServiceUnavailableError(
      "No speech-to-text provider is configured",
    );
  }

  const startTime = Date.now();
  let wavPath: string | null = null;
  try {
    wavPath = await toWav(filePath, isVideo);
    const text = await transcribeWithProvider(wavPath, transcriber);
    const durationSeconds = (Date.now() - startTime) / 1000;
    return {
      transcript: text,
      provider: transcriber.providerId,
      durationSeconds,
    };
  } catch (err) {
    // Only provider failures (tagged as SttError by transcribeChunk) are
    // categorized into HTTP statuses. Local preprocessing failures (ffmpeg/
    // ffprobe) stay on the bad-gateway path so their stderr never decides the
    // category (e.g. a path under a dir named "403" must not become a 401).
    if (err instanceof SttError) {
      // Auth/rate-limit/timeout/invalid-audio are user-config or transient
      // conditions, not daemon defects, so log them at warn to keep them out
      // of error telemetry. Reserve error level (with the raw err for a Sentry
      // stack) for genuine provider/unexpected failures.
      if (err.category === "provider-error") {
        log.error({ err, filePath }, "File transcription failed");
      } else {
        log.warn(
          { category: err.category, message: err.message, filePath },
          "File transcription failed",
        );
      }
      throw STT_ERROR_MAP[err.category]();
    }

    log.error({ err, filePath }, "File transcription failed");
    throw new BadGatewayError(
      err instanceof Error ? err.message : "Transcription failed",
    );
  } finally {
    if (wavPath) {
      await unlink(wavPath).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "stt_providers",
    endpoint: "stt/providers",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List STT providers",
    description:
      "Return the catalog of available STT providers with client-facing metadata.",
    tags: ["stt"],
    responseBody: z.object({
      providers: z.array(
        z.object({
          id: z.string(),
          displayName: z.string(),
          subtitle: z.string().optional(),
          setupMode: z.string().optional(),
          setupHint: z.string().optional(),
          apiKeyProviderName: z.string().optional(),
          conversationStreamingMode: z.string().optional(),
          credentialsGuide: z.string().optional(),
        }),
      ),
    }),
    handler: handleListProviders,
  },
  {
    operationId: "stt_transcribe",
    endpoint: "stt/transcribe",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Transcribe audio to text",
    description:
      "Transcribe base64-encoded audio to text using the configured STT provider.",
    tags: ["stt"],
    requestBody: z.object({
      audioBase64: z
        .string()
        .describe("Base64-encoded audio data to transcribe"),
      mimeType: z
        .string()
        .describe(
          'MIME type of the audio data (must start with "audio/", e.g. "audio/wav", "audio/ogg")',
        ),
      source: z
        .string()
        .optional()
        .describe(
          "Optional source identifier for analytics (e.g. 'dictation', 'voice-mode')",
        ),
    }),
    responseBody: z.object({
      text: z.string(),
      providerId: z.string(),
      boundaryId: z.string().optional(),
    }),
    handler: handleTranscribe,
  },
  {
    operationId: "stt_transcribe_file",
    endpoint: "stt/transcribe-file",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    summary: "Transcribe audio/video file to text",
    description:
      "Transcribe an audio or video file to text using the configured STT provider. Handles ffmpeg conversion, large-file chunking, and sequential chunk transcription.",
    tags: ["stt"],
    requestBody: z.object({
      filePath: z.string().describe("Absolute path to the audio or video file"),
    }),
    responseBody: z.object({
      transcript: z.string(),
      provider: z.string(),
      durationSeconds: z.number(),
    }),
    handler: handleTranscribeFile,
  },
];

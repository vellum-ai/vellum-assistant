/**
 * Transport-agnostic route definitions for speech-to-text.
 *
 * GET  /v1/stt/providers  — list available STT providers and their metadata
 * POST /v1/stt/transcribe — transcribe base64-encoded audio to text
 */

import { z } from "zod";

import { listProviderEntries } from "../../providers/speech-to-text/provider-catalog.js";
import { resolveBatchTranscriber } from "../../providers/speech-to-text/resolve.js";
import { normalizeSttError } from "../../stt/daemon-batch-transcriber.js";
import type { SttErrorCategory } from "../../stt/types.js";
import { getLogger } from "../../util/logger.js";
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

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "stt_providers",
    endpoint: "stt/providers",
    method: "GET",
    policyKey: "stt/providers",
    requirePolicyEnforcement: true,
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
    policyKey: "stt/transcribe",
    requirePolicyEnforcement: true,
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
];

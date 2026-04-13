/**
 * HTTP route definitions for speech-to-text transcription.
 *
 * POST /v1/stt/transcribe — transcribe base64-encoded audio to text
 *
 * Uses the globally configured STT provider via the `services.stt`
 * abstraction. Provider selection is resolved via `resolveBatchTranscriber()`
 * from `providers/speech-to-text/resolve.ts`.
 */

import { z } from "zod";

import { resolveBatchTranscriber } from "../../providers/speech-to-text/resolve.js";
import { normalizeSttError } from "../../stt/daemon-batch-transcriber.js";
import type { SttErrorCategory } from "../../stt/types.js";
import { getLogger } from "../../util/logger.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";

const log = getLogger("stt-routes");

/** Timeout for a single transcription request. */
const TRANSCRIPTION_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Error category -> HTTP status / message mapping
// ---------------------------------------------------------------------------

const STT_ERROR_MAP: Record<
  SttErrorCategory,
  { status: number; code: string; message: string }
> = {
  auth: {
    status: 401,
    code: "UNAUTHORIZED",
    message: "STT provider credentials are invalid or missing",
  },
  "rate-limit": {
    status: 429,
    code: "RATE_LIMITED",
    message: "STT provider rate limit exceeded",
  },
  timeout: {
    status: 504,
    code: "INTERNAL_ERROR",
    message: "STT transcription timed out",
  },
  "invalid-audio": {
    status: 400,
    code: "BAD_REQUEST",
    message: "Audio payload was rejected by the STT provider",
  },
  "provider-error": {
    status: 502,
    code: "INTERNAL_ERROR",
    message: "STT provider error",
  },
};

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function sttRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "stt/transcribe",
      method: "POST",
      policyKey: "stt/transcribe",
      summary: "Transcribe audio to text",
      description:
        "Transcribe base64-encoded audio to text using the configured STT provider. " +
        "Provider selection is resolved globally via config.",
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
      handler: async ({ req }) => {
        // -- Parse body -------------------------------------------------------
        let body: {
          audioBase64?: unknown;
          mimeType?: unknown;
          source?: unknown;
        };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return httpError("BAD_REQUEST", "Invalid JSON body", 400);
        }

        if (!body || typeof body !== "object") {
          return httpError("BAD_REQUEST", "Invalid JSON body", 400);
        }

        // -- Validate audioBase64 ---------------------------------------------
        if (
          !body.audioBase64 ||
          typeof body.audioBase64 !== "string" ||
          body.audioBase64.length === 0
        ) {
          return httpError(
            "BAD_REQUEST",
            "audioBase64 is required and must be a non-empty string",
            400,
          );
        }

        // -- Validate mimeType ------------------------------------------------
        if (
          !body.mimeType ||
          typeof body.mimeType !== "string" ||
          !body.mimeType.startsWith("audio/")
        ) {
          return httpError(
            "BAD_REQUEST",
            'mimeType is required and must start with "audio/"',
            400,
          );
        }

        // -- Decode audio -----------------------------------------------------
        // Buffer.from(str, "base64") silently accepts malformed input rather
        // than throwing, so we validate the characters explicitly first.
        const base64Str = body.audioBase64 as string;
        if (
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
            base64Str,
          )
        ) {
          return httpError(
            "BAD_REQUEST",
            "Invalid base64 encoding in audioBase64",
            400,
          );
        }

        let audioBuffer: Buffer;
        try {
          audioBuffer = Buffer.from(base64Str, "base64");
        } catch {
          return httpError(
            "BAD_REQUEST",
            "audioBase64 could not be decoded",
            400,
          );
        }

        if (audioBuffer.length === 0) {
          return httpError(
            "BAD_REQUEST",
            "Decoded audio payload is empty",
            400,
          );
        }

        // -- Resolve transcriber ----------------------------------------------
        let transcriber;
        try {
          transcriber = await resolveBatchTranscriber();
        } catch (err) {
          log.error({ err }, "Failed to resolve STT transcriber");
          return httpError(
            "SERVICE_UNAVAILABLE",
            "STT provider is not available",
            503,
          );
        }

        if (!transcriber) {
          return httpError(
            "SERVICE_UNAVAILABLE",
            "No speech-to-text provider is configured",
            503,
          );
        }

        // -- Transcribe with timeout ------------------------------------------
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

          return Response.json({
            text: result.text,
            providerId: transcriber.providerId,
            boundaryId: transcriber.boundaryId,
          });
        } catch (err) {
          const sttErr = normalizeSttError(err);
          const mapped = STT_ERROR_MAP[sttErr.category];

          log.warn(
            {
              category: sttErr.category,
              message: sttErr.message,
              source: body.source,
            },
            "STT transcription failed",
          );

          return httpError(
            mapped.code as Parameters<typeof httpError>[0],
            mapped.message,
            mapped.status,
          );
        } finally {
          clearTimeout(timeoutId);
        }
      },
    },
  ];
}

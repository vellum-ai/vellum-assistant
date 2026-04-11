/**
 * HTTP route definitions for text-to-speech synthesis.
 *
 * POST /v1/messages/:id/tts?conversationId=... — synthesize message text to audio
 * POST /v1/tts/synthesize                      — synthesize arbitrary text to audio
 *
 * Both endpoints use the globally configured TTS provider via the provider
 * abstraction. The message endpoint is gated behind the `message-tts`
 * assistant feature flag; the generic endpoint is always available when a
 * TTS provider is configured.
 */

import { z } from "zod";

import { sanitizeForTts } from "../../calls/tts-text-sanitizer.js";
import { isAssistantFeatureFlagEnabled } from "../../config/assistant-feature-flags.js";
import { getConfig } from "../../config/loader.js";
import { getMessageContent } from "../../daemon/handlers/conversation-history.js";
import { synthesizeText } from "../../tts/synthesize-text.js";
import { getLogger } from "../../util/logger.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";

const log = getLogger("tts-routes");

const MESSAGE_TTS_FLAG = "message-tts" as const;

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function ttsRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "messages/:id/tts",
      method: "POST",
      policyKey: "messages/tts",
      summary: "Synthesize message to speech",
      description:
        "Synthesize a message's text content to audio using the configured TTS provider.",
      tags: ["messages"],
      queryParams: [
        {
          name: "conversationId",
          schema: { type: "string" },
          description: "Conversation that contains the message",
        },
      ],
      handler: async ({ url, params }) => {
        const config = getConfig();

        if (!isAssistantFeatureFlagEnabled(MESSAGE_TTS_FLAG, config)) {
          return httpError("FORBIDDEN", "Message TTS is not enabled", 403);
        }

        const messageId = params.id;
        const conversationId =
          url.searchParams.get("conversationId") ?? undefined;

        const result = getMessageContent(messageId, conversationId);
        if (!result) {
          return httpError("NOT_FOUND", `Message ${messageId} not found`, 404);
        }

        if (!result.text) {
          return httpError("BAD_REQUEST", "Message has no text content", 400);
        }

        const sanitizedText = sanitizeForTts(result.text).trim();
        if (!sanitizedText) {
          return httpError(
            "BAD_REQUEST",
            "Message has no speakable text content",
            400,
          );
        }

        try {
          const { audio, contentType } = await synthesizeText({
            text: sanitizedText,
            useCase: "message-playback",
          });

          return new Response(new Uint8Array(audio), {
            status: 200,
            headers: { "Content-Type": contentType },
          });
        } catch (err) {
          log.error({ err, messageId }, "TTS synthesis failed");

          // Surface provider-not-configured as 503
          if (
            err instanceof Error &&
            "code" in err &&
            (err as { code: string }).code === "TTS_PROVIDER_NOT_CONFIGURED"
          ) {
            return httpError(
              "SERVICE_UNAVAILABLE",
              "TTS provider is not configured",
              503,
            );
          }

          return httpError("INTERNAL_ERROR", "TTS synthesis failed", 502);
        }
      },
    },

    // -- Generic text synthesis -----------------------------------------------

    {
      endpoint: "tts/synthesize",
      method: "POST",
      policyKey: "tts/synthesize",
      summary: "Synthesize text to speech",
      description:
        "Synthesize arbitrary text to audio using the configured TTS provider. " +
        "Provider selection is resolved globally via config — callers do not " +
        "specify a provider.",
      tags: ["tts"],
      requestBody: z.object({
        text: z.string().describe("Text to synthesize into speech"),
        context: z
          .string()
          .optional()
          .describe(
            "Optional context hint for output policy or capability selection (e.g. voice-mode). " +
              "Does not affect provider selection.",
          ),
        conversationId: z
          .string()
          .optional()
          .describe("Optional conversation ID for scoping or analytics."),
      }),
      responseBody: z.object({
        audio: z.string().describe("Raw audio binary (response body)"),
      }),
      handler: async ({ req }) => {
        let body: { text?: string; context?: string; conversationId?: string };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return httpError("BAD_REQUEST", "Invalid JSON body", 400);
        }

        if (!body.text || typeof body.text !== "string") {
          return httpError("BAD_REQUEST", "text is required", 400);
        }

        const sanitizedText = sanitizeForTts(body.text).trim();
        if (!sanitizedText) {
          return httpError(
            "BAD_REQUEST",
            "Text has no speakable content after sanitization",
            400,
          );
        }

        try {
          const { audio, contentType } = await synthesizeText({
            text: sanitizedText,
            useCase: "message-playback",
          });

          return new Response(new Uint8Array(audio), {
            status: 200,
            headers: { "Content-Type": contentType },
          });
        } catch (err) {
          log.error({ err, context: body.context }, "TTS synthesis failed");

          // Surface provider-not-configured as 503
          if (
            err instanceof Error &&
            "code" in err &&
            (err as { code: string }).code === "TTS_PROVIDER_NOT_CONFIGURED"
          ) {
            return httpError(
              "SERVICE_UNAVAILABLE",
              "TTS provider is not configured",
              503,
            );
          }

          return httpError("INTERNAL_ERROR", "TTS synthesis failed", 502);
        }
      },
    },
  ];
}

/**
 * HTTP route definitions for message text-to-speech synthesis.
 *
 * POST /v1/messages/:id/tts?conversationId=... — synthesize message text to audio
 *
 * Gated behind the `feature_flags.message-tts.enabled` assistant feature flag.
 * Uses Fish Audio for synthesis when configured.
 */

import { synthesizeWithFishAudio } from "../../calls/fish-audio-client.js";
import { sanitizeForTts } from "../../calls/tts-text-sanitizer.js";
import { isAssistantFeatureFlagEnabled } from "../../config/assistant-feature-flags.js";
import { getConfig } from "../../config/loader.js";
import { getMessageContent } from "../../daemon/handlers/conversation-history.js";
import { getLogger } from "../../util/logger.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";

const log = getLogger("tts-routes");

const MESSAGE_TTS_FLAG = "feature_flags.message-tts.enabled" as const;

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function ttsRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "messages/:id/tts",
      method: "POST",
      policyKey: "messages/tts",
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

        const sanitizedText = sanitizeForTts(result.text);
        if (!sanitizedText.trim()) {
          return httpError(
            "BAD_REQUEST",
            "Message has no speakable text content",
            400,
          );
        }

        const { fishAudio } = config;
        if (!fishAudio?.referenceId) {
          return httpError(
            "SERVICE_UNAVAILABLE",
            "Fish Audio TTS is not configured",
            503,
          );
        }

        try {
          const audioBuffer = await synthesizeWithFishAudio(
            sanitizedText,
            fishAudio,
          );

          const format = fishAudio.format ?? "mp3";
          const contentType =
            format === "wav"
              ? "audio/wav"
              : format === "opus"
                ? "audio/opus"
                : "audio/mpeg";

          return new Response(new Uint8Array(audioBuffer), {
            status: 200,
            headers: { "Content-Type": contentType },
          });
        } catch (err) {
          log.error({ err, messageId }, "TTS synthesis failed");
          return httpError("INTERNAL_ERROR", "TTS synthesis failed", 502);
        }
      },
    },
  ];
}

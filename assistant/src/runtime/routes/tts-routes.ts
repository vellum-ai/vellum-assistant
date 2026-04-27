/**
 * Transport-agnostic route definitions for text-to-speech synthesis.
 *
 * POST /v1/messages/:messageId/tts?conversationId=... — synthesize message text
 * POST /v1/tts/synthesize                             — synthesize arbitrary text
 *
 * Both endpoints use the globally configured TTS provider. The message
 * endpoint is gated behind the `message-tts` feature flag; the generic
 * endpoint is always available when a provider is configured.
 */

import { z } from "zod";

import { sanitizeForTts } from "../../calls/tts-text-sanitizer.js";
import { isAssistantFeatureFlagEnabled } from "../../config/assistant-feature-flags.js";
import { getConfig } from "../../config/loader.js";
import { getMessageContent } from "../../daemon/handlers/conversation-history.js";
import {
  synthesizeText,
  TtsSynthesisError,
} from "../../tts/synthesize-text.js";
import { resolveTtsConfig } from "../../tts/tts-config-resolver.js";
import { getLogger } from "../../util/logger.js";
import {
  BadGatewayError,
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
} from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("tts-routes");

const MESSAGE_TTS_FLAG = "message-tts" as const;

// ---------------------------------------------------------------------------
// Content-type resolution from config
// ---------------------------------------------------------------------------

/** Fish Audio format → MIME type mapping. */
const FISH_FORMAT_CONTENT_TYPE: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  opus: "audio/opus",
};

/**
 * Resolve the TTS output content type from the current config.
 *
 * For `message-playback` (the only use case for these routes):
 * - ElevenLabs always returns MP3 (mp3_44100_128)
 * - Fish Audio uses the configured format (default: mp3)
 * - All other providers default to audio/mpeg
 */
function resolveTtsContentType(): string {
  try {
    const config = getConfig();
    const { provider, providerConfig } = resolveTtsConfig(config);

    if (provider === "fish-audio") {
      const format = (providerConfig.format as string) ?? "mp3";
      return FISH_FORMAT_CONTENT_TYPE[format] ?? "audio/mpeg";
    }

    return "audio/mpeg";
  } catch {
    return "audio/mpeg";
  }
}

// ---------------------------------------------------------------------------
// Shared synthesis helper
// ---------------------------------------------------------------------------

async function doSynthesize(
  text: string,
  logContext: Record<string, unknown>,
): Promise<Uint8Array> {
  try {
    const { audio } = await synthesizeText({
      text,
      useCase: "message-playback",
    });
    return new Uint8Array(audio);
  } catch (err) {
    log.error({ err, ...logContext }, "TTS synthesis failed");

    if (
      err instanceof TtsSynthesisError &&
      err.code === "TTS_PROVIDER_NOT_CONFIGURED"
    ) {
      throw new ServiceUnavailableError("TTS provider is not configured");
    }

    throw new BadGatewayError("TTS synthesis failed");
  }
}

// ---------------------------------------------------------------------------
// Response headers — shared by both routes
// ---------------------------------------------------------------------------

const ttsResponseHeaders = () => ({
  "Content-Type": resolveTtsContentType(),
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleMessageTts({ pathParams, queryParams }: RouteHandlerArgs) {
  const config = getConfig();

  if (!isAssistantFeatureFlagEnabled(MESSAGE_TTS_FLAG, config)) {
    throw new ForbiddenError("Message TTS is not enabled");
  }

  const messageId = pathParams?.messageId;
  if (!messageId) {
    throw new BadRequestError("messageId path parameter is required");
  }

  const conversationId = queryParams?.conversationId;

  const result = getMessageContent(messageId, conversationId);
  if (!result) {
    throw new NotFoundError(`Message ${messageId} not found`);
  }

  if (!result.text) {
    throw new BadRequestError("Message has no text content");
  }

  const sanitizedText = sanitizeForTts(result.text).trim();
  if (!sanitizedText) {
    throw new BadRequestError("Message has no speakable text content");
  }

  return doSynthesize(sanitizedText, { messageId });
}

async function handleSynthesizeTts({ body }: RouteHandlerArgs) {
  if (!body?.text || typeof body.text !== "string") {
    throw new BadRequestError("text is required");
  }

  const sanitizedText = sanitizeForTts(body.text).trim();
  if (!sanitizedText) {
    throw new BadRequestError(
      "Text has no speakable content after sanitization",
    );
  }

  return doSynthesize(sanitizedText, { context: body.context });
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "messages_tts",
    endpoint: "messages/:messageId/tts",
    method: "POST",
    policyKey: "messages/tts",
    requirePolicyEnforcement: true,
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
    responseHeaders: ttsResponseHeaders,
    handler: handleMessageTts,
  },
  {
    operationId: "tts_synthesize",
    endpoint: "tts/synthesize",
    method: "POST",
    policyKey: "tts/synthesize",
    requirePolicyEnforcement: true,
    summary: "Synthesize text to speech",
    description:
      "Synthesize arbitrary text to audio using the configured TTS provider.",
    tags: ["tts"],
    requestBody: z.object({
      text: z.string().describe("Text to synthesize into speech"),
      context: z
        .string()
        .optional()
        .describe(
          "Optional context hint for output policy or capability selection.",
        ),
      conversationId: z
        .string()
        .optional()
        .describe("Optional conversation ID for scoping or analytics."),
    }),
    responseHeaders: ttsResponseHeaders,
    handler: handleSynthesizeTts,
  },
];

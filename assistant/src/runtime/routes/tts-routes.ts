/**
 * Transport-agnostic route definitions for text-to-speech synthesis.
 *
 * POST /v1/tts/synthesize — synthesize arbitrary text using the globally
 * configured TTS provider; available whenever a provider is configured.
 */

import { z } from "zod";

import { sanitizeForTts } from "../../calls/tts-text-sanitizer.js";
import { getConfig } from "../../config/loader.js";
import { listCatalogProvidersForDisplay } from "../../tts/provider-catalog.js";
import {
  synthesizeText,
  TtsSynthesisError,
} from "../../tts/synthesize-text.js";
import { resolveTtsConfig } from "../../tts/tts-config-resolver.js";
import type { TtsUseCase } from "../../tts/types.js";
import { getLogger } from "../../util/logger.js";
import { ACTOR_PRINCIPALS, LOCAL_PRINCIPALS } from "../auth/route-policy.js";
import {
  BadGatewayError,
  BadRequestError,
  ServiceUnavailableError,
} from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

const log = getLogger("tts-routes");

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

    throw new BadGatewayError(formatTtsFailureMessage(err));
  }
}

/**
 * Build a user-facing error message for a failed TTS synthesis, embedding the
 * upstream provider's message when available.
 *
 * The provider adapters surface a clean upstream message (e.g. "Free users
 * cannot use library voices via the API…") and `synthesize-text` already
 * prefixes those with `"TTS synthesis failed (provider: <id>): "`. We pass
 * pre-prefixed messages through verbatim and only add the base prefix for
 * raw provider errors, so users never see double- or triple-prefixed
 * messages on the desktop / channels.
 *
 * Exported for unit testing.
 */
export function formatTtsFailureMessage(err: unknown): string {
  const base = "TTS synthesis failed";
  if (err instanceof Error && err.message && err.message.trim()) {
    const trimmed = err.message.trim();
    if (/^TTS synthesis failed\b/i.test(trimmed)) {
      return trimmed;
    }
    return `${base}: ${trimmed}`;
  }
  return base;
}

// ---------------------------------------------------------------------------
// Response headers
// ---------------------------------------------------------------------------

const ttsResponseHeaders = () => ({
  "Content-Type": resolveTtsContentType(),
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function handleListTtsProviders() {
  return { providers: listCatalogProvidersForDisplay() };
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

async function handleSynthesizeCliTts({ body }: RouteHandlerArgs) {
  if (!body?.text || typeof body.text !== "string") {
    throw new BadRequestError("text is required");
  }

  const sanitizedText = sanitizeForTts(body.text).trim();
  if (!sanitizedText) {
    throw new BadRequestError(
      "Text has no speakable content after sanitization",
    );
  }

  const useCase: TtsUseCase =
    (body.useCase as TtsUseCase | undefined) ?? "message-playback";
  const voiceId =
    body.voiceId && typeof body.voiceId === "string" ? body.voiceId : undefined;

  try {
    const result = await synthesizeText({
      text: sanitizedText,
      useCase,
      voiceId,
    });
    return {
      audioBase64: Buffer.from(result.audio).toString("base64"),
      contentType: result.contentType,
    };
  } catch (err) {
    log.error({ err }, "TTS CLI synthesis failed");

    if (
      err instanceof TtsSynthesisError &&
      err.code === "TTS_PROVIDER_NOT_CONFIGURED"
    ) {
      throw new ServiceUnavailableError("TTS provider is not configured");
    }

    throw new BadGatewayError(formatTtsFailureMessage(err));
  }
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "tts_providers",
    endpoint: "tts/providers",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List TTS providers",
    description:
      "Return the catalog of available TTS providers with client-facing metadata.",
    tags: ["tts"],
    responseBody: z.object({
      providers: z.array(
        z.object({
          id: z.string(),
          displayName: z.string(),
          subtitle: z.string(),
          supportsVoiceSelection: z.boolean(),
          apiKeyPlaceholder: z.string(),
          credentialsGuide: z.object({
            description: z.string(),
            url: z.string(),
            linkLabel: z.string(),
          }),
        }),
      ),
    }),
    handler: handleListTtsProviders,
  },
  {
    operationId: "tts_synthesize",
    endpoint: "tts/synthesize",
    method: "POST",
    policy: {
      requiredScopes: ["chat.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
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
  {
    operationId: "tts_synthesize_cli",
    endpoint: "tts/synthesize-cli",
    method: "POST",
    policy: {
      requiredScopes: ["chat.read"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    summary: "Synthesize text to speech (CLI)",
    description:
      "Synthesize arbitrary text to audio. Returns base64-encoded audio + content type for CLI consumption.",
    tags: ["tts"],
    requestBody: z.object({
      text: z.string().describe("Text to synthesize into speech"),
      useCase: z
        .enum(["message-playback", "phone-call"])
        .optional()
        .default("message-playback"),
      voiceId: z
        .string()
        .optional()
        .describe("Provider-specific voice identifier override"),
    }),
    responseBody: z.object({
      audioBase64: z.string().describe("Base64-encoded audio bytes"),
      contentType: z
        .string()
        .describe("MIME type of the audio (e.g. audio/mpeg)"),
    }),
    handler: handleSynthesizeCliTts,
  },
];

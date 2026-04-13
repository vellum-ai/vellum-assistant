import { z } from "zod";

import { listCatalogProviderIds } from "../../tts/provider-catalog.js";
import type { TtsProviderId } from "../../tts/types.js";
import {
  DEFAULT_ELEVENLABS_VOICE_ID,
  VALID_CONVERSATION_TIMEOUTS,
} from "./elevenlabs.js";

/**
 * Valid TTS provider identifiers derived from the canonical provider catalog.
 *
 * Adding a new TTS provider starts in `provider-catalog.ts` — the IDs flow
 * here automatically.
 */
export const VALID_TTS_PROVIDERS: readonly [string, ...string[]] =
  listCatalogProviderIds() as [TtsProviderId, ...TtsProviderId[]];

/**
 * Per-provider config schemas nested under `services.tts.providers.<id>`.
 *
 * Each provider's schema is the full provider-specific config (voice ID,
 * model overrides, tuning params, etc.). These are identical to the
 * legacy top-level schemas (`elevenlabs.*`, `fishAudio.*`) so that
 * migration can copy values 1:1.
 */
export const TtsElevenLabsProviderConfigSchema = z
  .object({
    voiceId: z
      .string({
        error: "services.tts.providers.elevenlabs.voiceId must be a string",
      })
      .min(1, "services.tts.providers.elevenlabs.voiceId must not be empty")
      .default(DEFAULT_ELEVENLABS_VOICE_ID)
      .describe("ElevenLabs voice ID for text-to-speech"),
    voiceModelId: z
      .string({
        error:
          "services.tts.providers.elevenlabs.voiceModelId must be a string",
      })
      .default("")
      .describe(
        "ElevenLabs model ID override (leave empty to use the default model)",
      ),
    speed: z
      .number({
        error: "services.tts.providers.elevenlabs.speed must be a number",
      })
      .min(0.7, "services.tts.providers.elevenlabs.speed must be >= 0.7")
      .max(1.2, "services.tts.providers.elevenlabs.speed must be <= 1.2")
      .default(1.0)
      .describe(
        "Speech playback speed multiplier (0.7 = slower, 1.2 = faster)",
      ),
    stability: z
      .number({
        error: "services.tts.providers.elevenlabs.stability must be a number",
      })
      .min(0, "services.tts.providers.elevenlabs.stability must be >= 0")
      .max(1, "services.tts.providers.elevenlabs.stability must be <= 1")
      .default(0.5)
      .describe(
        "Voice stability — higher values produce more consistent speech, lower values add expressiveness",
      ),
    similarityBoost: z
      .number({
        error:
          "services.tts.providers.elevenlabs.similarityBoost must be a number",
      })
      .min(0, "services.tts.providers.elevenlabs.similarityBoost must be >= 0")
      .max(1, "services.tts.providers.elevenlabs.similarityBoost must be <= 1")
      .default(0.75)
      .describe(
        "How closely the output matches the original voice — higher values increase similarity",
      ),
    conversationTimeoutSeconds: z
      .number({
        error:
          "services.tts.providers.elevenlabs.conversationTimeoutSeconds must be a number",
      })
      .refine(
        (v) =>
          VALID_CONVERSATION_TIMEOUTS.includes(
            v as (typeof VALID_CONVERSATION_TIMEOUTS)[number],
          ),
        {
          message: `services.tts.providers.elevenlabs.conversationTimeoutSeconds must be one of: ${VALID_CONVERSATION_TIMEOUTS.join(", ")}`,
        },
      )
      .default(30)
      .describe("Seconds of silence before voice conversation auto-ends"),
  })
  .describe("ElevenLabs provider configuration under services.tts");

export type TtsElevenLabsProviderConfig = z.infer<
  typeof TtsElevenLabsProviderConfigSchema
>;

export const TtsFishAudioProviderConfigSchema = z
  .object({
    referenceId: z
      .string({
        error: "services.tts.providers.fish-audio.referenceId must be a string",
      })
      .default("")
      .describe("Fish Audio voice/clone reference ID"),
    chunkLength: z
      .number({
        error: "services.tts.providers.fish-audio.chunkLength must be a number",
      })
      .int("services.tts.providers.fish-audio.chunkLength must be an integer")
      .min(100, "services.tts.providers.fish-audio.chunkLength must be >= 100")
      .max(300, "services.tts.providers.fish-audio.chunkLength must be <= 300")
      .default(200)
      .describe("Text chunk size for streaming synthesis"),
    format: z
      .enum(["mp3", "wav", "opus"], {
        error:
          "services.tts.providers.fish-audio.format must be one of: mp3, wav, opus",
      })
      .default("mp3")
      .describe("Output audio format"),
    latency: z
      .enum(["normal", "balanced"], {
        error:
          "services.tts.providers.fish-audio.latency must be one of: normal, balanced",
      })
      .default("normal")
      .describe(
        "Latency/quality tradeoff for Fish Audio S2 synthesis. 'normal' prioritizes lower latency; 'balanced' trades latency for higher quality.",
      ),
    speed: z
      .number({
        error: "services.tts.providers.fish-audio.speed must be a number",
      })
      .min(0.5, "services.tts.providers.fish-audio.speed must be >= 0.5")
      .max(2.0, "services.tts.providers.fish-audio.speed must be <= 2.0")
      .default(1.0)
      .describe("Playback speed multiplier (0.5 = slower, 2.0 = faster)"),
  })
  .describe("Fish Audio provider configuration under services.tts");

export type TtsFishAudioProviderConfig = z.infer<
  typeof TtsFishAudioProviderConfigSchema
>;

export const TtsProvidersSchema = z.object({
  elevenlabs: TtsElevenLabsProviderConfigSchema.default(
    TtsElevenLabsProviderConfigSchema.parse({}),
  ),
  "fish-audio": TtsFishAudioProviderConfigSchema.default(
    TtsFishAudioProviderConfigSchema.parse({}),
  ),
});
export type TtsProviders = z.infer<typeof TtsProvidersSchema>;

// ---------------------------------------------------------------------------
// Catalog-completeness guard
// ---------------------------------------------------------------------------
// Ensures every provider in the catalog has a corresponding key in
// TtsProvidersSchema. If a new provider is added to the catalog without a
// schema entry, this fires at module-load time so the oversight is caught
// immediately rather than at runtime when a user selects the provider.
// ---------------------------------------------------------------------------
const schemaKeys = new Set(Object.keys(TtsProvidersSchema.shape));
for (const id of VALID_TTS_PROVIDERS) {
  if (!schemaKeys.has(id)) {
    throw new Error(
      `TTS provider "${id}" exists in the catalog but has no schema entry ` +
        `in TtsProvidersSchema. Add a "services.tts.providers.${id}" schema.`,
    );
  }
}

/**
 * Canonical TTS service configuration.
 *
 * `mode` is locked to `"your-own"` — managed TTS is not supported.
 * Attempting to set `mode: "managed"` will fail schema validation.
 */
export const TtsServiceSchema = z
  .object({
    mode: z
      .literal("your-own", {
        error:
          'services.tts.mode must be "your-own" — managed TTS is not supported',
      })
      .default("your-own" as const)
      .describe(
        'TTS service mode — only "your-own" is supported (managed TTS is not available)',
      ),
    provider: z
      .enum(VALID_TTS_PROVIDERS, {
        error: `services.tts.provider must be one of: ${VALID_TTS_PROVIDERS.join(", ")}`,
      })
      .default("elevenlabs")
      .describe("Active TTS provider used for speech synthesis"),
    providers: TtsProvidersSchema.default(TtsProvidersSchema.parse({})),
  })
  .describe(
    "Text-to-speech service configuration — provider selection and per-provider settings",
  );

export type TtsService = z.infer<typeof TtsServiceSchema>;

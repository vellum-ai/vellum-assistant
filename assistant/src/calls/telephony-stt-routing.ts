/**
 * Telephony STT routing resolver.
 *
 * Maps the `services.stt.provider` value to a discriminated telephony
 * setup strategy that downstream TwiML generation and media-stream
 * adapters can consume without re-deriving provider semantics.
 *
 * Two strategy variants exist:
 *
 * - **`conversation-relay-native`** — the STT provider is natively
 *   supported by Twilio ConversationRelay. TwiML includes
 *   `transcriptionProvider` / `speechModel` attributes and Twilio
 *   handles audio ingestion. Used for `deepgram` and `google-gemini`.
 *
 * - **`media-stream-custom`** — the STT provider is not natively
 *   supported by Twilio. A `<Stream>` media-stream is opened instead
 *   and the daemon transcribes audio server-side via the provider's
 *   batch API. Used for `openai-whisper`.
 *
 * Model normalization semantics for Twilio-native providers:
 * - Deepgram defaults `speechModel` to `"nova-3"` when unset.
 * - Google leaves `speechModel` undefined when unset. The legacy
 *   Deepgram default `"nova-3"` is treated as unset for Google so
 *   workspaces that switched providers don't send a Deepgram model
 *   name to Google's API.
 */

import { getConfig } from "../config/loader.js";
import { getProviderEntry } from "../providers/speech-to-text/provider-catalog.js";
import type { SttProviderId } from "../stt/types.js";

// ---------------------------------------------------------------------------
// Strategy types
// ---------------------------------------------------------------------------

/**
 * Twilio-native ConversationRelay transcription provider name.
 *
 * These are the values Twilio accepts in the `transcriptionProvider`
 * TwiML attribute on `<ConversationRelay>`.
 */
export type TwilioNativeTranscriptionProvider = "Deepgram" | "Google";

/**
 * The configured STT provider maps to a Twilio-native
 * ConversationRelay transcription path.
 */
export interface ConversationRelayNativeStrategy {
  readonly strategy: "conversation-relay-native";
  /** Provider ID from `services.stt.provider`. */
  readonly providerId: SttProviderId;
  /** Twilio-native provider name for the TwiML attribute. */
  readonly transcriptionProvider: TwilioNativeTranscriptionProvider;
  /** ASR model identifier, or undefined to use the provider default. */
  readonly speechModel: string | undefined;
}

/**
 * The configured STT provider requires a media-stream for custom
 * server-side transcription.
 */
export interface MediaStreamCustomStrategy {
  readonly strategy: "media-stream-custom";
  /** Provider ID from `services.stt.provider`. */
  readonly providerId: SttProviderId;
}

/**
 * Discriminated union of telephony setup strategies.
 */
export type TelephonySttStrategy =
  | ConversationRelayNativeStrategy
  | MediaStreamCustomStrategy;

/**
 * Result of resolving a telephony STT routing decision.
 *
 * - `resolved` — the provider was recognized and a strategy was determined.
 * - `unknown-provider` — the provider ID is not in the catalog or has no
 *   telephony routing mapping.
 */
export type TelephonySttRoutingResult =
  | { status: "resolved"; strategy: TelephonySttStrategy }
  | { status: "unknown-provider"; providerId: string; reason: string };

// ---------------------------------------------------------------------------
// Model normalization constants
// ---------------------------------------------------------------------------

const DEEPGRAM_DEFAULT_SPEECH_MODEL = "nova-3";

// ---------------------------------------------------------------------------
// Provider-to-strategy mapping
// ---------------------------------------------------------------------------

/**
 * Map from `services.stt.provider` ID to the corresponding Twilio-native
 * transcription provider name. Providers absent from this map use the
 * media-stream custom path.
 */
const TWILIO_NATIVE_PROVIDER_MAP: ReadonlyMap<
  SttProviderId,
  TwilioNativeTranscriptionProvider
> = new Map<SttProviderId, TwilioNativeTranscriptionProvider>([
  ["deepgram", "Deepgram"],
  ["google-gemini", "Google"],
]);

// ---------------------------------------------------------------------------
// Model normalization
// ---------------------------------------------------------------------------

/**
 * Resolve the effective speech model for a Twilio-native provider.
 *
 * - Deepgram: falls back to `"nova-3"` when the model is unset.
 * - Google: leaves the model undefined when unset. Treats the legacy
 *   Deepgram default `"nova-3"` as unset so that workspaces that were
 *   previously configured for Deepgram don't send a Deepgram model name
 *   to Google's Cloud Speech API.
 */
function resolveNativeSpeechModel(
  twilioProvider: TwilioNativeTranscriptionProvider,
  rawSpeechModel: string | undefined,
): string | undefined {
  const isGoogle = twilioProvider === "Google";

  if (rawSpeechModel == null) {
    return isGoogle ? undefined : DEEPGRAM_DEFAULT_SPEECH_MODEL;
  }

  // Legacy migration: suppress the Deepgram default when provider is Google.
  if (rawSpeechModel === DEEPGRAM_DEFAULT_SPEECH_MODEL && isGoogle) {
    return undefined;
  }

  return rawSpeechModel;
}

// ---------------------------------------------------------------------------
// Public resolver
// ---------------------------------------------------------------------------

/**
 * Resolve the telephony STT routing strategy from `services.stt.provider`.
 *
 * Reads the active provider from config, checks the provider catalog for
 * validity, then maps to either a Twilio-native ConversationRelay strategy
 * or a media-stream custom strategy.
 *
 * @param speechModel - Optional raw speech model from config. When provided,
 *   model normalization is applied for Twilio-native providers. Sourced
 *   from `calls.voice.speechModel`.
 */
export function resolveTelephonySttRouting(
  speechModel?: string | undefined,
): TelephonySttRoutingResult {
  const config = getConfig();
  const providerId = config.services.stt.provider;

  // Validate the provider exists in the catalog.
  const entry = getProviderEntry(providerId as SttProviderId);
  if (!entry) {
    return {
      status: "unknown-provider",
      providerId,
      reason: `STT provider "${providerId}" is not in the provider catalog`,
    };
  }

  // Check if this provider maps to a Twilio-native transcription path.
  const twilioProvider = TWILIO_NATIVE_PROVIDER_MAP.get(entry.id);

  if (twilioProvider) {
    return {
      status: "resolved",
      strategy: {
        strategy: "conversation-relay-native",
        providerId: entry.id,
        transcriptionProvider: twilioProvider,
        speechModel: resolveNativeSpeechModel(twilioProvider, speechModel),
      },
    };
  }

  // Provider is recognized but not Twilio-native — use media-stream path.
  return {
    status: "resolved",
    strategy: {
      strategy: "media-stream-custom",
      providerId: entry.id,
    },
  };
}

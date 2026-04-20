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
 *   batch API. Used for `openai-whisper` and `xai`.
 *
 * Strategy selection and model normalization are driven entirely by
 * the provider catalog's `telephonyRouting` metadata — this module
 * contains no hardcoded provider-to-Twilio maps.
 */

import { getConfig } from "../config/loader.js";
import {
  getProviderEntry,
  type TwilioNativeProvider,
} from "../providers/speech-to-text/provider-catalog.js";
import type { SttProviderId } from "../stt/types.js";

// ---------------------------------------------------------------------------
// Strategy types
// ---------------------------------------------------------------------------

/**
 * Twilio-native ConversationRelay transcription provider name.
 *
 * Re-exported from the provider catalog for downstream consumers that
 * reference the strategy types without importing the catalog directly.
 */
export type TwilioNativeTranscriptionProvider = TwilioNativeProvider;

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
// Public resolver
// ---------------------------------------------------------------------------

/**
 * Resolve the telephony STT routing strategy from `services.stt.provider`.
 *
 * Reads the active provider from config, checks the provider catalog for
 * validity, then derives the telephony strategy from the catalog entry's
 * `telephonyRouting` metadata.
 */
export function resolveTelephonySttRouting(): TelephonySttRoutingResult {
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

  const { telephonyRouting } = entry;

  // Derive strategy from catalog routing metadata.
  if (telephonyRouting.strategyKind === "conversation-relay-native") {
    const mapping = telephonyRouting.twilioNativeMapping;

    // Defensive: conversation-relay-native entries must have a mapping.
    if (!mapping) {
      return {
        status: "unknown-provider",
        providerId: entry.id,
        reason: `Provider "${entry.id}" declares conversation-relay-native strategy but has no twilioNativeMapping`,
      };
    }

    return {
      status: "resolved",
      strategy: {
        strategy: "conversation-relay-native",
        providerId: entry.id,
        transcriptionProvider: mapping.provider,
        speechModel: mapping.defaultSpeechModel,
      },
    };
  }

  // media-stream-custom path.
  return {
    status: "resolved",
    strategy: {
      strategy: "media-stream-custom",
      providerId: entry.id,
    },
  };
}

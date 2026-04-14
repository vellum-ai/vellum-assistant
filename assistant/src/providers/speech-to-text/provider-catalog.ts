/**
 * STT provider catalog — single source of truth for provider metadata.
 *
 * Every STT provider is described by a {@link SttProviderEntry} that
 * captures its canonical ID, the credential-provider name used to look up
 * API keys, supported runtime boundaries, and telephony support mode.
 *
 * All other modules that need provider metadata (resolve.ts,
 * daemon-batch-transcriber.ts, future telephony adapters) read from this
 * catalog rather than maintaining their own hardcoded maps.
 */

import type {
  ConversationStreamingMode,
  SttBoundaryId,
  SttProviderId,
  TelephonySttMode,
} from "../../stt/types.js";

// ---------------------------------------------------------------------------
// Telephony routing metadata
// ---------------------------------------------------------------------------

/**
 * Strategy kind for telephony call setup.
 *
 * Determines how the telephony routing resolver (`telephony-stt-routing.ts`)
 * wires the STT provider into a Twilio call:
 *
 * - `"conversation-relay-native"` — the provider is natively supported by
 *   Twilio ConversationRelay. TwiML includes `transcriptionProvider` /
 *   `speechModel` attributes and Twilio handles audio ingestion.
 * - `"media-stream-custom"` — the provider is not natively supported by
 *   Twilio. A `<Stream>` media-stream is opened and the daemon transcribes
 *   audio server-side via the provider's batch API.
 */
export type TelephonyStrategyKind =
  | "conversation-relay-native"
  | "media-stream-custom";

/**
 * Twilio-native ConversationRelay provider name.
 *
 * These are the values Twilio accepts in the `transcriptionProvider` TwiML
 * attribute on `<ConversationRelay>`.
 */
export type TwilioNativeProvider = "Deepgram" | "Google";

/**
 * Twilio-native mapping details for providers routed through
 * ConversationRelay. Only present when `strategyKind` is
 * `"conversation-relay-native"`.
 */
export interface TwilioNativeMapping {
  /** Twilio-native provider name for the TwiML `transcriptionProvider` attribute. */
  readonly provider: TwilioNativeProvider;
  /**
   * Default ASR speech model identifier, or `undefined` to use the
   * provider's default model. Individual providers override as needed
   * (e.g. Deepgram defaults to `"nova-3"`).
   */
  readonly defaultSpeechModel: string | undefined;
}

/**
 * Telephony routing metadata — the single source of truth for how a
 * provider is wired into Twilio call setup.
 *
 * The telephony routing resolver reads these fields from the catalog
 * instead of maintaining its own hardcoded maps.
 */
export interface TelephonyRouting {
  /** Which Twilio call-setup strategy this provider uses. */
  readonly strategyKind: TelephonyStrategyKind;
  /**
   * Twilio-native mapping details. Present when `strategyKind` is
   * `"conversation-relay-native"`, absent for `"media-stream-custom"`.
   */
  readonly twilioNativeMapping?: TwilioNativeMapping;
}

// ---------------------------------------------------------------------------
// Catalog entry
// ---------------------------------------------------------------------------

/**
 * Metadata for a single STT provider.
 */
export interface SttProviderEntry {
  /** Canonical provider identifier (must match an {@link SttProviderId} variant). */
  readonly id: SttProviderId;

  /**
   * Name of the credential provider used by `getProviderKeyAsync` to
   * retrieve the API key. Multiple STT providers may share a credential
   * provider (e.g. a future "openai-realtime" provider would also map to
   * `"openai"`).
   */
  readonly credentialProvider: string;

  /**
   * Set of runtime boundaries this provider supports. A provider may
   * support more than one boundary (e.g. both `daemon-batch` and a future
   * `realtime-ws` boundary).
   */
  readonly supportedBoundaries: ReadonlySet<SttBoundaryId>;

  /**
   * Telephony capability class — describes the provider's native
   * audio-ingestion capability for telephony contexts.
   */
  readonly telephonyMode: TelephonySttMode;

  /**
   * Conversation streaming mode — describes whether and how the provider
   * can participate in real-time conversation chat message capture
   * (chat composer and iOS input bar).
   *
   * - `"realtime-ws"` — native WebSocket streaming with partial/final events.
   * - `"incremental-batch"` — polling-based incremental batch approximation.
   * - `"none"` — no streaming support; fall back to batch transcription.
   */
  readonly conversationStreamingMode: ConversationStreamingMode;

  /**
   * Telephony routing metadata — describes how this provider is wired
   * into Twilio call setup. This is the single source of truth for
   * strategy selection and Twilio-native mapping details.
   */
  readonly telephonyRouting: TelephonyRouting;
}

// ---------------------------------------------------------------------------
// Catalog data
// ---------------------------------------------------------------------------

/**
 * Provider catalog entries, keyed by provider ID.
 *
 * To add a new STT provider:
 * 1. Add a new variant to `SttProviderId` in `stt/types.ts`.
 * 2. Add an entry here with the credential mapping and boundary support.
 * 3. Wire up the adapter in `daemon-batch-transcriber.ts` (and/or a
 *    future realtime adapter) for the boundaries the provider supports.
 */
const CATALOG: ReadonlyMap<SttProviderId, SttProviderEntry> = new Map<
  SttProviderId,
  SttProviderEntry
>([
  [
    "deepgram",
    {
      id: "deepgram",
      credentialProvider: "deepgram",
      supportedBoundaries: new Set<SttBoundaryId>([
        "daemon-batch",
        "daemon-streaming",
      ]),
      telephonyMode: "realtime-ws",
      conversationStreamingMode: "realtime-ws",
      telephonyRouting: {
        strategyKind: "conversation-relay-native",
        twilioNativeMapping: {
          provider: "Deepgram",
          defaultSpeechModel: "nova-3",
        },
      },
    },
  ],
  [
    "google-gemini",
    {
      id: "google-gemini",
      credentialProvider: "gemini",
      supportedBoundaries: new Set<SttBoundaryId>([
        "daemon-batch",
        "daemon-streaming",
      ]),
      telephonyMode: "batch-only",
      conversationStreamingMode: "incremental-batch",
      telephonyRouting: {
        strategyKind: "conversation-relay-native",
        twilioNativeMapping: {
          provider: "Google",
          defaultSpeechModel: undefined,
        },
      },
    },
  ],
  [
    "openai-whisper",
    {
      id: "openai-whisper",
      credentialProvider: "openai",
      supportedBoundaries: new Set<SttBoundaryId>([
        "daemon-batch",
        "daemon-streaming",
      ]),
      telephonyMode: "batch-only",
      conversationStreamingMode: "incremental-batch",
      telephonyRouting: {
        strategyKind: "media-stream-custom",
      },
    },
  ],
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Look up a provider entry by its canonical ID.
 *
 * Returns `undefined` when the ID is not present in the catalog (e.g. an
 * unknown runtime value that passed schema validation).
 */
export function getProviderEntry(
  id: SttProviderId,
): SttProviderEntry | undefined {
  return CATALOG.get(id);
}

/**
 * Return all catalog entries in deterministic (insertion) order.
 */
export function listProviderEntries(): readonly SttProviderEntry[] {
  return [...CATALOG.values()];
}

/**
 * Look up the credential-provider name for a given STT provider.
 *
 * Convenience wrapper around `getProviderEntry` for callers that only need
 * the credential mapping. Returns `undefined` when the provider is unknown.
 */
export function getCredentialProvider(id: SttProviderId): string | undefined {
  return CATALOG.get(id)?.credentialProvider;
}

/**
 * Check whether a provider supports a specific runtime boundary.
 *
 * Returns `false` for unknown provider IDs.
 */
export function supportsBoundary(
  id: SttProviderId,
  boundary: SttBoundaryId,
): boolean {
  return CATALOG.get(id)?.supportedBoundaries.has(boundary) ?? false;
}

/**
 * Return all canonical provider IDs in deterministic (insertion) order.
 */
export function listProviderIds(): readonly SttProviderId[] {
  return [...CATALOG.keys()];
}

/**
 * Return the deduplicated set of credential-provider names used by STT
 * providers, in deterministic (first-seen) order.
 *
 * Multiple STT providers may share a single credential provider (e.g.
 * `openai-whisper` and a future `openai-realtime` both map to `"openai"`).
 * This helper deduplicates so that callers composing API-key provider
 * lists do not produce duplicate entries.
 */
export function listCredentialProviderNames(): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of CATALOG.values()) {
    if (!seen.has(entry.credentialProvider)) {
      seen.add(entry.credentialProvider);
      result.push(entry.credentialProvider);
    }
  }
  return result;
}

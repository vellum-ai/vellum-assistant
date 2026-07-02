/**
 * TTS provider definition model.
 *
 * A {@link TtsProviderDefinition} is the complete, statically-declared
 * description of one TTS provider: catalog metadata (identity, display
 * fields, call mode, capabilities, secret requirements), the runtime
 * {@link TtsProvider} adapter, and — for native-Twilio providers — the
 * Twilio voice-spec builder.
 *
 * Each provider module (`providers/<id>-provider.ts`) exports one
 * definition; `provider-catalog.ts` assembles them into the canonical
 * catalog, statically checked to cover every {@link CatalogTtsProviderId}.
 * There is no runtime registration step — a provider that exists in the
 * catalog is fully wired by construction.
 *
 * This module holds types only (its single import is the sibling `types.ts`
 * leaf) so provider modules can implement the contract without importing
 * the catalog that aggregates them.
 */

import type {
  CatalogTtsProviderId,
  TtsCallMode,
  TtsProvider,
} from "./types.js";

// ---------------------------------------------------------------------------
// Catalog metadata
// ---------------------------------------------------------------------------

/**
 * Metadata about a secret (API key / credential) required by a provider.
 */
export interface TtsProviderSecretRequirement {
  /**
   * The key used to retrieve this secret from the secure credential store.
   *
   * For simple keys this is a bare name (e.g. `"elevenlabs"`).
   * For namespaced keys this follows the `credential/{service}/{field}`
   * convention (e.g. `"credential/fish-audio/api_key"`).
   */
  readonly credentialStoreKey: string;

  /** Human-readable label shown in settings UI and error messages. */
  readonly displayName: string;

  /**
   * CLI command the user can run to store this secret.
   *
   * Shown in error messages when the key is missing.
   */
  readonly setCommand: string;
}

/**
 * Provider-level capabilities metadata surfaced by the catalog.
 *
 * These describe static, provider-wide traits — they do not change based
 * on runtime configuration or per-request parameters.
 */
export interface TtsProviderCatalogCapabilities {
  /** Whether the provider supports chunk-level streaming synthesis. */
  readonly supportsStreaming: boolean;

  /** Audio formats the provider can produce (e.g. `["mp3"]`). */
  readonly supportedFormats: readonly string[];
}

/**
 * Output format the provider's adapter produces when a caller requests
 * PCM output (`outputFormat: "pcm"`) for media-stream playback.
 *
 * The media-stream transport can only transcode raw PCM or WAV
 * (PCM-in-container) to mu-law — compressed formats (mp3, opus) produce
 * garbled audio. Providers whose adapter honours the PCM hint declare
 * `"pcm"`; providers that substitute WAV declare `"wav"`; providers that
 * can only produce compressed audio declare `"none"` and are not playable
 * over media-stream transports.
 */
export type TtsMediaStreamOutputFormat = "pcm" | "wav" | "none";

/**
 * How the provider's synthesized audio plays over media-stream transports.
 */
export interface TtsMediaStreamPlayback {
  /** Format the adapter produces for media-stream (PCM-hinted) requests. */
  readonly outputFormat: TtsMediaStreamOutputFormat;
}

/**
 * Link to a provider's API-key management page, shown in settings UI.
 */
export interface TtsCredentialsGuide {
  readonly description: string;
  readonly url: string;
  readonly linkLabel: string;
}

// ---------------------------------------------------------------------------
// Native Twilio voice spec
// ---------------------------------------------------------------------------

/**
 * Builds the provider-specific voice spec string for a native Twilio
 * provider.
 *
 * The returned string is used as Twilio's TTS `voice` attribute. Its
 * format is provider-specific — e.g. ElevenLabs uses
 * `voiceId-modelId-speed_stability_similarity`.
 *
 * @param providerConfig - Provider-specific config block from
 *   `services.tts.providers.<id>`.
 * @returns The voice spec string for Twilio's TTS `voice` attribute, or
 *   an empty string if the provider has no voice to specify.
 */
export type NativeTwilioVoiceSpecBuilder = (
  providerConfig: Record<string, unknown>,
) => string;

/**
 * Twilio voice-spec builder metadata for a native-Twilio provider.
 */
export interface NativeTwilioVoiceSpec {
  /** The Twilio `ttsProvider` attribute value (e.g. `"ElevenLabs"`). */
  readonly twilioProviderName: string;

  /** Builds the `voice` attribute string from provider config. */
  readonly buildVoiceSpec: NativeTwilioVoiceSpecBuilder;
}

// ---------------------------------------------------------------------------
// Catalog entry / provider definition
// ---------------------------------------------------------------------------

/**
 * The metadata half of a provider definition — identity, display name,
 * telephony call mode, capabilities, secret requirements, and client-facing
 * display fields. Consumers that only need metadata (settings UI, config
 * validation, call routing) work against this shape.
 */
export interface TtsProviderCatalogEntry {
  /** Unique provider identifier. */
  readonly id: CatalogTtsProviderId;

  /** Human-readable name for display in settings UI and logs. */
  readonly displayName: string;

  /** Short description shown beneath the provider name in settings UI. */
  readonly subtitle: string;

  /** Whether the provider supports user-chosen voice IDs. */
  readonly supportsVoiceSelection: boolean;

  /** Placeholder text for the API-key input in settings UI. */
  readonly apiKeyPlaceholder: string;

  /** Link to the provider's API-key management page. */
  readonly credentialsGuide: TtsCredentialsGuide;

  /** How this provider integrates with the telephony call path. */
  readonly callMode: TtsCallMode;

  /**
   * Whether the call path may fall back to the text-token path when
   * synthesized audio fails.
   *
   * Providers with `callMode: "native-twilio"` always set this to `true`.
   * Synthesized-play providers with a usable token fallback (e.g. Fish
   * Audio) set this to `true` so callers still hear a response if
   * synthesis fails. Providers without one (e.g. Deepgram) set this to
   * `false` — a synthesis failure must propagate so the outer error
   * handler can surface a user-facing recovery message.
   */
  readonly allowNativeFallback: boolean;

  /** Static provider-level capabilities. */
  readonly capabilities: Readonly<TtsProviderCatalogCapabilities>;

  /** How the provider's audio plays over media-stream transports. */
  readonly mediaStreamPlayback: Readonly<TtsMediaStreamPlayback>;

  /** Secrets the provider requires to function. */
  readonly secretRequirements: readonly Readonly<TtsProviderSecretRequirement>[];
}

/**
 * A complete provider definition: catalog metadata plus the runtime adapter.
 *
 * The union is discriminated on `callMode` so that a `"native-twilio"`
 * provider **must** declare its {@link NativeTwilioVoiceSpec} — the
 * pairing the call path depends on is enforced at compile time rather
 * than by a boot-time registration check.
 */
export type TtsProviderDefinition =
  | (TtsProviderCatalogEntry & {
      readonly callMode: "native-twilio";
      /** Twilio voice-spec builder consumed by the call strategy. */
      readonly nativeTwilioVoiceSpec: NativeTwilioVoiceSpec;
      /** The runtime synthesis adapter. */
      readonly adapter: TtsProvider;
    })
  | (TtsProviderCatalogEntry & {
      readonly callMode: "synthesized-play";
      /** The runtime synthesis adapter. */
      readonly adapter: TtsProvider;
    });

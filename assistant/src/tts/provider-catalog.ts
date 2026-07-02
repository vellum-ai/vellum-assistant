/**
 * Canonical TTS provider catalog.
 *
 * This module is the **single source of truth** for provider IDs and
 * provider-level metadata on the assistant side. Every TTS provider that
 * the system knows about is declared here — downstream modules query the
 * catalog via {@link getCatalogProvider}, {@link listCatalogProviders}, or
 * {@link listCatalogProviderIds} instead of hardcoding provider IDs.
 *
 * Adding a new TTS provider starts here: create a new
 * {@link TtsProviderCatalogEntry} and append it to {@link CATALOG}.
 */

import type { TtsCallMode, TtsProviderId } from "./types.js";

// ---------------------------------------------------------------------------
// Catalog entry model
// ---------------------------------------------------------------------------

/**
 * Metadata about a secret (API key / credential) required by a provider.
 */
interface TtsProviderSecretRequirement {
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
interface TtsProviderCatalogCapabilities {
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
interface TtsCredentialsGuide {
  readonly description: string;
  readonly url: string;
  readonly linkLabel: string;
}

/**
 * A single entry in the TTS provider catalog.
 *
 * Captures everything the system needs to know about a provider at a
 * metadata level — identity, display name, telephony call mode,
 * capabilities, secret requirements, and client-facing display metadata.
 */
export interface TtsProviderCatalogEntry {
  /** Unique provider identifier matching {@link TtsProviderId}. */
  readonly id: TtsProviderId;

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
   * Whether the call path may fall back to native Twilio token-based
   * TTS when synthesized audio fails.
   *
   * Providers with `callMode: "native-twilio"` always set this to `true`.
   * Synthesized-play providers that also work through Twilio's built-in
   * TTS (e.g. Fish Audio) set this to `true` so callers still hear
   * a response if synthesis fails. Providers that have **no** native
   * Twilio integration (e.g. Deepgram) set this to `false` — a synthesis
   * failure must propagate so the outer error handler can surface a
   * user-facing recovery message.
   */
  readonly allowNativeFallback: boolean;

  /** Static provider-level capabilities. */
  readonly capabilities: Readonly<TtsProviderCatalogCapabilities>;

  /** How the provider's audio plays over media-stream transports. */
  readonly mediaStreamPlayback: Readonly<TtsMediaStreamPlayback>;

  /** Secrets the provider requires to function. */
  readonly secretRequirements: readonly Readonly<TtsProviderSecretRequirement>[];
}

// ---------------------------------------------------------------------------
// Catalog data
// ---------------------------------------------------------------------------

/**
 * The authoritative list of TTS providers.
 *
 * Order is significant only for display purposes (e.g. settings dropdowns).
 */
const CATALOG: readonly TtsProviderCatalogEntry[] = [
  {
    id: "elevenlabs",
    displayName: "ElevenLabs",
    subtitle:
      "High-quality voice synthesis for conversations and read-aloud. Requires an ElevenLabs API key.",
    supportsVoiceSelection: true,
    apiKeyPlaceholder: "sk_…",
    credentialsGuide: {
      description:
        "Sign in to ElevenLabs, go to your Profile, and copy your API key.",
      url: "https://elevenlabs.io/app/settings/api-keys",
      linkLabel: "Open ElevenLabs API Keys",
    },
    callMode: "native-twilio",
    allowNativeFallback: true,
    capabilities: {
      supportsStreaming: false,
      supportedFormats: ["mp3"],
    },
    // The adapter honours the PCM hint via `pcm_16000` output.
    mediaStreamPlayback: { outputFormat: "pcm" },
    secretRequirements: [
      {
        credentialStoreKey: "credential/elevenlabs/api_key",
        displayName: "ElevenLabs API Key",
        setCommand:
          "assistant credentials set --service elevenlabs --field api_key <key>",
      },
    ],
  },
  {
    id: "fish-audio",
    displayName: "Fish Audio",
    subtitle:
      "Natural-sounding voice synthesis with custom voice cloning. Requires a Fish Audio API key and voice reference ID.",
    supportsVoiceSelection: true,
    apiKeyPlaceholder: "Enter your Fish Audio API key",
    credentialsGuide: {
      description:
        "Sign in to Fish Audio, navigate to API Keys in your dashboard, and create a new key.",
      url: "https://fish.audio/app/api-keys/",
      linkLabel: "Open Fish Audio API Keys",
    },
    callMode: "synthesized-play",
    allowNativeFallback: true,
    capabilities: {
      supportsStreaming: true,
      supportedFormats: ["mp3", "wav", "opus"],
    },
    // The adapter substitutes WAV for the PCM hint (no raw PCM support).
    mediaStreamPlayback: { outputFormat: "wav" },
    secretRequirements: [
      {
        credentialStoreKey: "credential/fish-audio/api_key",
        displayName: "Fish Audio API Key",
        setCommand:
          "assistant credentials set --service fish-audio --field api_key <key>",
      },
    ],
  },
  {
    id: "deepgram",
    displayName: "Deepgram",
    subtitle:
      "Fast, accurate text-to-speech synthesis. Uses the same API key as Deepgram speech-to-text.",
    supportsVoiceSelection: false,
    apiKeyPlaceholder: "Enter your Deepgram API key",
    credentialsGuide: {
      description:
        "Sign in to Deepgram, navigate to your API Keys page, and create or copy an existing key. This is the same key used for speech-to-text.",
      url: "https://console.deepgram.com/",
      linkLabel: "Open Deepgram Console",
    },
    callMode: "synthesized-play",
    allowNativeFallback: false,
    capabilities: {
      supportsStreaming: false,
      supportedFormats: ["mp3", "wav", "opus"],
    },
    // The adapter honours the PCM hint via `linear16` + `container=none`.
    mediaStreamPlayback: { outputFormat: "pcm" },
    secretRequirements: [
      {
        credentialStoreKey: "credential/deepgram/api_key",
        displayName: "Deepgram API Key",
        setCommand: "assistant keys set deepgram <key>",
      },
    ],
  },
  {
    id: "xai",
    displayName: "xAI",
    subtitle:
      "Text-to-speech from xAI with expressive voices (eve, ara, rex, sal, leo). Requires an xAI API key.",
    supportsVoiceSelection: false,
    apiKeyPlaceholder: "Enter your xAI API key",
    credentialsGuide: {
      description:
        "Sign in to the xAI console, navigate to API Keys, and create a new key.",
      url: "https://console.x.ai/",
      linkLabel: "Open xAI Console",
    },
    callMode: "synthesized-play",
    allowNativeFallback: false,
    capabilities: {
      supportsStreaming: false,
      supportedFormats: ["mp3", "wav"],
    },
    // The adapter honours the PCM hint via the `pcm` codec.
    mediaStreamPlayback: { outputFormat: "pcm" },
    secretRequirements: [
      {
        credentialStoreKey: "credential/xai/api_key",
        displayName: "xAI API Key",
        setCommand:
          "assistant credentials set --service xai --field api_key <key>",
      },
    ],
  },
] as const;

/** Index for O(1) lookup by provider ID. */
const catalogById = new Map<TtsProviderId, TtsProviderCatalogEntry>(
  CATALOG.map((entry) => [entry.id, entry]),
);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * List all catalog providers in display order.
 */
export function listCatalogProviders(): readonly TtsProviderCatalogEntry[] {
  return CATALOG;
}

/**
 * List all known provider IDs in display order.
 */
export function listCatalogProviderIds(): TtsProviderId[] {
  return CATALOG.map((entry) => entry.id);
}

/**
 * List all catalog providers projected to client-facing display fields only.
 */
export function listCatalogProvidersForDisplay() {
  return CATALOG.map((e) => ({
    id: e.id,
    displayName: e.displayName,
    subtitle: e.subtitle,
    supportsVoiceSelection: e.supportsVoiceSelection,
    apiKeyPlaceholder: e.apiKeyPlaceholder,
    credentialsGuide: e.credentialsGuide,
  }));
}

/**
 * Look up a catalog entry by provider ID.
 *
 * @throws if the ID is not in the catalog.
 */
export function getCatalogProvider(id: TtsProviderId): TtsProviderCatalogEntry {
  const entry = catalogById.get(id);
  if (!entry) {
    const known = listCatalogProviderIds();
    throw new Error(
      `Unknown TTS provider "${id}" is not in the catalog. ` +
        `Known providers: ${known.join(", ")}`,
    );
  }
  return entry;
}

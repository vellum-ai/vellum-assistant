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

export type { TtsCallMode } from "./types.js";

// ---------------------------------------------------------------------------
// Catalog entry model
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
 * A single entry in the TTS provider catalog.
 *
 * Captures everything the system needs to know about a provider at a
 * metadata level — identity, display name, telephony call mode,
 * capabilities, and secret requirements.
 */
export interface TtsProviderCatalogEntry {
  /** Unique provider identifier matching {@link TtsProviderId}. */
  readonly id: TtsProviderId;

  /** Human-readable name for display in settings UI and logs. */
  readonly displayName: string;

  /** How this provider integrates with the telephony call path. */
  readonly callMode: TtsCallMode;

  /** Static provider-level capabilities. */
  readonly capabilities: Readonly<TtsProviderCatalogCapabilities>;

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
    callMode: "native-twilio",
    capabilities: {
      supportsStreaming: false,
      supportedFormats: ["mp3"],
    },
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
    callMode: "synthesized-play",
    capabilities: {
      supportsStreaming: true,
      supportedFormats: ["mp3", "wav", "opus"],
    },
    secretRequirements: [
      {
        credentialStoreKey: "credential/fish-audio/api_key",
        displayName: "Fish Audio API Key",
        setCommand:
          "assistant credentials set --service fish-audio --field api_key <key>",
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

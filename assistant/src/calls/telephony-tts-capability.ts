/**
 * Telephony TTS playability capability resolver.
 *
 * Validates whether a TTS provider can produce audio that is actually
 * playable over the media-stream call transport. Playability requires:
 *
 * 1. The catalog entry's `mediaStreamPlayback.outputFormat` is `"pcm"` or
 *    `"wav"` — the media-stream mu-law transcoder cannot decode compressed
 *    formats (mp3, opus).
 * 2. Every secret the catalog entry requires resolves to a value.
 *
 * This resolver does **not** create a provider instance — it only validates
 * catalog metadata and credentials, mirroring `resolveTelephonySttCapability`
 * in `providers/speech-to-text/resolve.ts`. Credential lookup is centralized
 * here (an authorized secure-keys importer) so callers don't need to import
 * secure-keys directly.
 */

import { getConfig } from "../config/loader.js";
import {
  getProviderKeyAsync,
  getSecureKeyAsync,
} from "../security/secure-keys.js";
import type { TtsProviderCatalogEntry } from "../tts/provider-catalog.js";
import { getCatalogProvider } from "../tts/provider-catalog.js";
import { resolveTtsConfig } from "../tts/tts-config-resolver.js";
import type { TtsProviderId } from "../tts/types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Why a provider cannot play over media-stream transports. */
export type TelephonyTtsNotPlayableReason =
  | "unsupported-format"
  | "missing-credentials";

/**
 * Result of resolving whether a TTS provider is playable over the
 * media-stream call transport.
 */
export type TelephonyTtsCapability =
  | {
      /** The provider produces playable audio and credentials resolve. */
      status: "playable";
      providerId: TtsProviderId;
    }
  | {
      /** The provider cannot play over media-stream transports. */
      status: "not-playable";
      providerId: TtsProviderId;
      reason: TelephonyTtsNotPlayableReason;
    };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate whether the configured `services.tts.provider` is playable over
 * the media-stream call transport.
 *
 * Callers can branch on the discriminated `status` field:
 * - `"playable"` — the provider produces PCM/WAV and credentials resolve.
 * - `"not-playable"` — see `reason` (`"unsupported-format"` when the
 *   provider is unknown or only produces compressed audio,
 *   `"missing-credentials"` when a required secret does not resolve).
 */
export async function resolveTelephonyTtsCapability(): Promise<TelephonyTtsCapability> {
  const { provider } = resolveTtsConfig(getConfig());
  return evaluateTelephonyTtsPlayability(provider);
}

/**
 * Evaluate media-stream playability for a specific catalog provider.
 *
 * Shared by {@link resolveTelephonyTtsCapability} (configured provider) and
 * the call TTS resolver's fallback scan (candidate providers).
 */
export async function evaluateTelephonyTtsPlayability(
  providerId: TtsProviderId,
): Promise<TelephonyTtsCapability> {
  let entry: TtsProviderCatalogEntry;
  try {
    entry = getCatalogProvider(providerId);
  } catch {
    // Unknown providers have no declared playable format.
    return { status: "not-playable", providerId, reason: "unsupported-format" };
  }

  if (entry.mediaStreamPlayback.outputFormat === "none") {
    return {
      status: "not-playable",
      providerId: entry.id,
      reason: "unsupported-format",
    };
  }

  for (const secret of entry.secretRequirements) {
    if (!(await secretResolves(secret.credentialStoreKey))) {
      return {
        status: "not-playable",
        providerId: entry.id,
        reason: "missing-credentials",
      };
    }
  }

  return { status: "playable", providerId: entry.id };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Check whether a catalog `credentialStoreKey` resolves to a value.
 *
 * API keys (`credential/{service}/api_key` or a bare service name) go
 * through `getProviderKeyAsync` so env-var-only setups are honoured;
 * other namespaced fields are looked up verbatim.
 */
async function secretResolves(credentialStoreKey: string): Promise<boolean> {
  const parts = credentialStoreKey.split("/");
  if (parts.length === 1) {
    return Boolean(await getProviderKeyAsync(credentialStoreKey));
  }
  if (parts.length === 3 && parts[0] === "credential" && parts[2] === "api_key") {
    return Boolean(await getProviderKeyAsync(parts[1]));
  }
  return Boolean(await getSecureKeyAsync(credentialStoreKey));
}

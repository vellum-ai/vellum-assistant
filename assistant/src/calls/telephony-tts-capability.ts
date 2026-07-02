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
 * 3. Provider-specific config invariants hold — Fish Audio requires a
 *    configured `referenceId` (no per-request voiceId is supplied on the
 *    telephony path), so a referenceId-less fish-audio setup synthesizes
 *    nothing and is not playable.
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
  | "missing-credentials"
  | "missing-fish-audio-reference-id";

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
 *   `"missing-credentials"` when a required secret does not resolve,
 *   `"missing-fish-audio-reference-id"` when fish-audio has no configured
 *   `referenceId`).
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

  if (entry.id === "fish-audio" && !fishAudioReferenceIdConfigured()) {
    return {
      status: "not-playable",
      providerId: entry.id,
      reason: "missing-fish-audio-reference-id",
    };
  }

  return { status: "playable", providerId: entry.id };
}

/**
 * Whether the fish-audio `referenceId` is configured.
 *
 * Single source of truth for the fish-audio usability invariant: the
 * telephony path supplies no per-request voiceId, so synthesis requires a
 * configured reference ID. Shared by {@link evaluateTelephonyTtsPlayability}
 * and the call TTS resolver's ConversationRelay degrade path.
 *
 * When fish-audio is the active `services.tts.provider`, its config is
 * read through the {@link resolveTtsConfig} provider-options layer — the
 * same path the call TTS resolver has always used. When fish-audio is only
 * a fallback candidate, the canonical `services.tts.providers.fish-audio`
 * block is read directly.
 */
export function fishAudioReferenceIdConfigured(): boolean {
  try {
    const config = getConfig();
    const resolved = resolveTtsConfig(config);
    const providerConfig =
      resolved.provider === "fish-audio"
        ? resolved.providerConfig
        : (
            config.services?.tts?.providers as
              | Record<string, unknown>
              | undefined
          )?.["fish-audio"];
    return Boolean(
      (
        providerConfig as { referenceId?: string } | undefined
      )?.referenceId?.trim(),
    );
  } catch {
    return false;
  }
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

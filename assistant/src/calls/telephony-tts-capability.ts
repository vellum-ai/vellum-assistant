/**
 * Telephony TTS playability guard for the media-stream call path.
 *
 * On the media-stream pipeline ALL telephony audio is synthesized by the
 * daemon and transcoded PCM/WAV -> mu-law before being sent to the carrier.
 * A TTS provider that cannot emit a transcodable linear format (PCM/WAV)
 * -- or whose credential is not available -- would produce a silent call.
 *
 * This module turns "can the configured provider feed the media-stream
 * transcoder?" into an explicit, testable decision driven by:
 *   1. the provider's declared {@link MediaStreamPlaybackFormat} in the
 *      canonical catalog, and
 *   2. whether the provider's credential is actually available.
 *
 * It deliberately does NOT key off {@link TtsCallMode} -- call mode describes
 * the Twilio integration strategy, not whether synthesized bytes are playable
 * over the media-stream transcoder.
 *
 * The credential-availability check ({@link isTtsProviderCredentialAvailable})
 * is exported for reuse by the call preflight path.
 */

import { loadConfig } from "../config/loader.js";
import { getSecureKeyAsync } from "../security/secure-keys.js";
import {
  getCatalogProvider,
  type MediaStreamPlaybackFormat,
} from "../tts/provider-catalog.js";
import { resolveTtsConfig } from "../tts/tts-config-resolver.js";
import type { TtsProviderId } from "../tts/types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default provider used when the configured provider cannot feed the
 * media-stream transcoder. ElevenLabs emits `pcm_16000` and is the catalog
 * default, so it is the safe PCM-capable fallback.
 */
export const DEFAULT_PLAYABLE_TTS_PROVIDER: TtsProviderId = "elevenlabs";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Why a configured provider cannot feed the media-stream transcoder.
 *
 * - `unsupported-format`  — the provider's declared media-stream output
 *                            format is `"none"` (it cannot emit PCM/WAV).
 * - `missing-credentials` — the provider could emit PCM/WAV but its
 *                            credential is not available.
 */
export type TelephonyTtsNotPlayableReason =
  | "unsupported-format"
  | "missing-credentials";

/** Result of {@link resolveTelephonyTtsCapability}. */
export type TelephonyTtsCapability =
  | { status: "playable"; providerId: TtsProviderId }
  | {
      status: "not-playable";
      providerId: TtsProviderId;
      reason: TelephonyTtsNotPlayableReason;
    };

// ---------------------------------------------------------------------------
// Credential availability (reusable)
// ---------------------------------------------------------------------------

/**
 * Returns true when the given provider's credential is available in the
 * secure store.
 *
 * Keys off the provider's `secretRequirements` in the canonical catalog
 * (the `credentialStoreKey`), so the check stays in lockstep with the
 * declared requirements. A provider with no declared secret requirements is
 * treated as always-available (e.g. keyless local providers).
 *
 * Exported for reuse by the call preflight path so the daemon can warn about
 * an unplayable telephony TTS config before a call connects.
 */
export async function isTtsProviderCredentialAvailable(
  providerId: TtsProviderId,
): Promise<boolean> {
  const entry = getCatalogProvider(providerId);
  if (entry.secretRequirements.length === 0) return true;
  for (const requirement of entry.secretRequirements) {
    const value = await getSecureKeyAsync(requirement.credentialStoreKey);
    if (value && value.trim().length > 0) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Capability resolution
// ---------------------------------------------------------------------------

/** A media-stream output format that the transcoder can actually play. */
function isPlayableFormat(format: MediaStreamPlaybackFormat): boolean {
  return format === "pcm" || format === "wav";
}

/**
 * Resolve whether the currently configured `services.tts.provider` can feed
 * the media-stream transcoder with playable audio.
 *
 * Returns `{ status: "playable" }` only when the provider's declared
 * media-stream output format is PCM/WAV **and** its credential is available.
 * Otherwise returns `{ status: "not-playable"; providerId; reason }`.
 */
export async function resolveTelephonyTtsCapability(): Promise<TelephonyTtsCapability> {
  const config = loadConfig();
  const resolved = resolveTtsConfig(config);
  const providerId = resolved.provider;
  const entry = getCatalogProvider(providerId);

  if (!isPlayableFormat(entry.mediaStreamPlayback.outputFormat)) {
    return { status: "not-playable", providerId, reason: "unsupported-format" };
  }

  const hasCredential = await isTtsProviderCredentialAvailable(providerId);
  if (!hasCredential) {
    return {
      status: "not-playable",
      providerId,
      reason: "missing-credentials",
    };
  }

  return { status: "playable", providerId };
}

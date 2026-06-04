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
import { credentialKey } from "../security/credential-key.js";
import {
  getProviderKeyAsync,
  getSecureKeyAsync,
} from "../security/secure-keys.js";
import {
  getCatalogProvider,
  type MediaStreamPlaybackFormat,
} from "../tts/provider-catalog.js";
import {
  resolveProviderTtsConfig,
  resolveTtsConfig,
} from "../tts/tts-config-resolver.js";
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
 * - `unsupported-format`    — the provider's declared media-stream output
 *                              format is `"none"` (it cannot emit PCM/WAV).
 * - `missing-credentials`   — the provider could emit PCM/WAV but its
 *                              credential is not available.
 * - `missing-required-config` — the provider is credentialed and can emit
 *                              PCM/WAV, but a required provider-specific config
 *                              value is missing, so synthesis would throw
 *                              before producing audio (e.g. fish-audio's
 *                              `referenceId`).
 */
export type TelephonyTtsNotPlayableReason =
  | "unsupported-format"
  | "missing-credentials"
  | "missing-required-config";

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
 * Returns true when the given provider's credential is available under the
 * SAME lookup semantics the TTS adapters use to read their key.
 *
 * The real adapters (e.g. the Deepgram adapter) resolve their key via
 * {@link getProviderKeyAsync}, which consults — in order — the namespaced
 * `credential/{provider}/api_key` store key, the legacy bare `{provider}`
 * store key, and the provider's env-var fallback. Probing only the catalog's
 * namespaced `credentialStoreKey` here would report a legacy- or
 * env-configured key as missing, wrongly triggering the fallback (or silence)
 * even though synthesis would actually succeed.
 *
 * Behavior is preserved for providers that declare a non-standard catalog
 * `credentialStoreKey` (one that is not `credential/{providerId}/api_key`):
 * those keys are still probed directly via {@link getSecureKeyAsync}, since
 * {@link getProviderKeyAsync} would not know to look for them.
 *
 * A provider with no declared secret requirements is treated as
 * always-available (e.g. keyless local providers).
 *
 * Exported for reuse by the call preflight path so the daemon can warn about
 * an unplayable telephony TTS config before a call connects.
 */
export async function isTtsProviderCredentialAvailable(
  providerId: TtsProviderId,
): Promise<boolean> {
  const entry = getCatalogProvider(providerId);
  if (entry.secretRequirements.length === 0) return true;

  // Primary probe: match the adapter's `getProviderKeyAsync` semantics so
  // legacy bare keys and env-var fallbacks are recognized.
  const providerKey = await getProviderKeyAsync(providerId);
  if (providerKey && providerKey.trim().length > 0) return true;

  // Preserve behavior for any requirement that uses a non-standard catalog
  // key (i.e. not the provider-namespaced api_key that getProviderKeyAsync
  // already covered above).
  const standardKey = credentialKey(providerId, "api_key");
  for (const requirement of entry.secretRequirements) {
    if (requirement.credentialStoreKey === standardKey) continue;
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
 * Provider-specific required-config invariants that must hold before the
 * provider can synthesize ANY audio on the telephony path.
 *
 * A provider listed here will throw at first synthesis (not emit silence)
 * when the predicate returns false, so the capability check must treat it as
 * NOT playable — the media-stream path has no native fallback, so it would go
 * silent otherwise.
 *
 * Each predicate receives the provider's resolved `services.tts.providers.<id>`
 * config block and returns true when the required config is present.
 *
 * - `fish-audio`: `createFishAudioProvider().synthesize()` throws
 *   `FISH_AUDIO_TTS_NO_REFERENCE_ID` when neither a per-request voiceId nor a
 *   configured `referenceId` is available. Telephony synthesis does not pass a
 *   voiceId, so a non-empty configured `referenceId` is required.
 */
const REQUIRED_CONFIG_CHECKS: Partial<
  Record<TtsProviderId, (providerConfig: Record<string, unknown>) => boolean>
> = {
  "fish-audio": (providerConfig) => {
    const referenceId = providerConfig.referenceId;
    return typeof referenceId === "string" && referenceId.trim().length > 0;
  },
};

/**
 * Whether the provider's required provider-specific config is present.
 *
 * Providers without a registered check are considered to have no required
 * config (always satisfied).
 */
function hasRequiredProviderConfig(
  providerId: TtsProviderId,
  providerConfig: Record<string, unknown>,
): boolean {
  const check = REQUIRED_CONFIG_CHECKS[providerId];
  return check ? check(providerConfig) : true;
}

/**
 * Resolve whether a specific provider (with its resolved config block) can
 * feed the media-stream transcoder with playable audio.
 *
 * Returns `{ status: "playable" }` only when ALL of the following hold:
 *   1. the provider's declared media-stream output format is PCM/WAV,
 *   2. its credential is available, and
 *   3. any provider-specific required config (e.g. fish-audio's `referenceId`)
 *      is present.
 * Otherwise returns `{ status: "not-playable"; providerId; reason }`.
 */
export async function resolveProviderTelephonyCapability(
  providerId: TtsProviderId,
  providerConfig: Record<string, unknown>,
): Promise<TelephonyTtsCapability> {
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

  if (!hasRequiredProviderConfig(providerId, providerConfig)) {
    return {
      status: "not-playable",
      providerId,
      reason: "missing-required-config",
    };
  }

  return { status: "playable", providerId };
}

/**
 * Resolve whether the currently configured `services.tts.provider` can feed
 * the media-stream transcoder with playable audio.
 *
 * Returns `{ status: "playable" }` only when the provider's declared
 * media-stream output format is PCM/WAV, its credential is available, **and**
 * any provider-specific required config (e.g. fish-audio's `referenceId`) is
 * present. Otherwise returns `{ status: "not-playable"; providerId; reason }`.
 */
export async function resolveTelephonyTtsCapability(): Promise<TelephonyTtsCapability> {
  const config = loadConfig();
  const resolved = resolveTtsConfig(config);
  return resolveProviderTelephonyCapability(
    resolved.provider,
    resolved.providerConfig,
  );
}

/**
 * Resolve whether an explicit provider id (e.g. the fallback default) can feed
 * the media-stream transcoder, reading that provider's config from the active
 * assistant config regardless of which provider is currently selected.
 */
export async function resolveTelephonyTtsCapabilityFor(
  providerId: TtsProviderId,
): Promise<TelephonyTtsCapability> {
  const config = loadConfig();
  const providerConfig = resolveProviderTtsConfig(config, providerId);
  return resolveProviderTelephonyCapability(providerId, providerConfig);
}

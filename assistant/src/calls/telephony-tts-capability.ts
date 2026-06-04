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
import {
  getProviderKeyAsync,
  getSecureKeyAsync,
} from "../security/secure-keys.js";
import {
  getCatalogProvider,
  getCatalogProviderOrNull,
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
 * - `unconfigured`          — no `services.tts.provider` is configured (a
 *                              partial/edge config, e.g. no `services.tts`
 *                              block). The resolver returns this instead of
 *                              throwing so the preflight can report a not-ready
 *                              gap rather than crash.
 * - `unknown-provider`      — the configured `services.tts.provider` is not in
 *                              the TTS catalog. Returned (not thrown) for the
 *                              same reason as `unconfigured`.
 */
export type TelephonyTtsNotPlayableReason =
  | "unsupported-format"
  | "missing-credentials"
  | "missing-required-config"
  | "unconfigured"
  | "unknown-provider";

/**
 * Result of {@link resolveTelephonyTtsCapability}.
 *
 * `providerId` is `null` only when the configured provider is missing
 * (`unconfigured`); for an `unknown-provider` it is the raw configured id so
 * callers can name it.
 */
export type TelephonyTtsCapability =
  | { status: "playable"; providerId: TtsProviderId }
  | {
      status: "not-playable";
      providerId: TtsProviderId | null;
      reason: TelephonyTtsNotPlayableReason;
    };

// ---------------------------------------------------------------------------
// Credential availability (reusable)
// ---------------------------------------------------------------------------

/** Whether a resolved credential string counts as present. */
function isPresent(value: string | undefined): boolean {
  return value != null && value.trim().length > 0;
}

/**
 * Returns true when the given provider's credential is available under the
 * SAME lookup semantics the provider's adapter uses to read its key.
 *
 * Adapters do NOT all read credentials the same way, and the probe MUST mirror
 * each one or it will disagree with reality (mark a provider playable, then
 * synthesis throws a no-key error → silent media-stream call). The lookup each
 * adapter performs is declared per requirement on the catalog as
 * {@link TtsCredentialLookup}:
 *
 * - `"provider-key"` (e.g. Deepgram): probed via {@link getProviderKeyAsync},
 *   which honors the namespaced `credential/{provider}/api_key` key, the legacy
 *   bare `{provider}` key, and the env-var fallback.
 * - `"namespaced-only"` (e.g. ElevenLabs, Fish Audio, xAI): probed via
 *   {@link getSecureKeyAsync} against the requirement's exact
 *   `credentialStoreKey` — the legacy bare key and env fallback are NOT
 *   honored, because the adapter doesn't honor them either.
 *
 * A provider is available when EVERY declared secret requirement resolves a
 * non-blank value under its own lookup. A provider with no declared secret
 * requirements is treated as always-available (e.g. keyless local providers).
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
    const value =
      requirement.credentialLookup === "provider-key"
        ? await getProviderKeyAsync(providerId)
        : await getSecureKeyAsync(requirement.credentialStoreKey);
    if (!isPresent(value)) return false;
  }
  return true;
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
  // Non-throwing catalog lookup: an unknown/malformed `services.tts.provider`
  // must resolve to a not-playable gap rather than throw, so the telephony
  // preflight can fail-before-dial (outbound) or speak setup-required + end
  // (inbound) instead of crashing or silently continuing into a silent call.
  const entry = getCatalogProviderOrNull(providerId);
  if (!entry) {
    return { status: "not-playable", providerId, reason: "unknown-provider" };
  }

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

  // Safe access: a partial/edge config (e.g. no `services.tts` block) must
  // resolve to a not-playable "unconfigured" gap rather than throwing — call
  // setup must never crash on a malformed config. This mirrors the STT leg
  // (`resolveTelephonySttCapability`), which returns "unconfigured" for the
  // same shape.
  const configuredProvider = config.services?.tts?.provider;
  if (!configuredProvider) {
    return { status: "not-playable", providerId: null, reason: "unconfigured" };
  }

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

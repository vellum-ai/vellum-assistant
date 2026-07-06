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
      providerId: string;
    }
  | {
      /** The provider cannot play over media-stream transports. */
      status: "not-playable";
      providerId: string;
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
  providerId: string,
): Promise<TelephonyTtsCapability> {
  const result = await findTtsProviderGap(
    providerId,
    (entry) => entry.mediaStreamPlayback.outputFormat !== "none",
  );
  if (result.gap === null) {
    return { status: "playable", providerId: result.entry.id };
  }

  switch (result.gap.kind) {
    case "unknown-provider":
      // Unknown providers have no declared playable format.
      return {
        status: "not-playable",
        providerId,
        reason: "unsupported-format",
      };
    case "unsupported-capability":
      return {
        status: "not-playable",
        providerId: result.gap.entry.id,
        reason: "unsupported-format",
      };
    case "missing-credentials":
      return {
        status: "not-playable",
        providerId: result.gap.entry.id,
        reason: "missing-credentials",
      };
    case "missing-fish-audio-reference-id":
      return {
        status: "not-playable",
        providerId: result.gap.entry.id,
        reason: "missing-fish-audio-reference-id",
      };
  }
}

// ---------------------------------------------------------------------------
// Shared provider-gap skeleton
// ---------------------------------------------------------------------------

/** A required secret declared by a TTS catalog entry. */
export type TtsProviderSecret =
  TtsProviderCatalogEntry["secretRequirements"][number];

/**
 * Why a TTS provider fails a capability preflight, before the caller maps it
 * onto its own transport-specific result/message shape.
 */
export type TtsProviderGap =
  | { kind: "unknown-provider" }
  | { kind: "unsupported-capability"; entry: TtsProviderCatalogEntry }
  | {
      kind: "missing-credentials";
      entry: TtsProviderCatalogEntry;
      secret: TtsProviderSecret;
    }
  | { kind: "missing-fish-audio-reference-id"; entry: TtsProviderCatalogEntry };

/** Result of {@link findTtsProviderGap}: the first gap found, or none. */
export type TtsProviderGapResult =
  | { gap: null; entry: TtsProviderCatalogEntry }
  | { gap: TtsProviderGap };

/**
 * Run the shared TTS-provider preflight skeleton: catalog lookup →
 * transport-specific capability predicate → required-secret resolution →
 * fish-audio referenceId invariant. Returns the first gap found, in that
 * order, or the catalog entry when the provider passes every check.
 *
 * Shared by {@link evaluateTelephonyTtsPlayability} (predicate:
 * media-stream-playable output format) and the live-voice credential
 * preflight (predicate: streaming synthesis support) so the two transports
 * stay behaviorally aligned everywhere except the capability itself.
 */
export async function findTtsProviderGap(
  providerId: string,
  supportsCapability: (entry: TtsProviderCatalogEntry) => boolean,
): Promise<TtsProviderGapResult> {
  let entry: TtsProviderCatalogEntry;
  try {
    entry = getCatalogProvider(providerId);
  } catch {
    return { gap: { kind: "unknown-provider" } };
  }

  if (!supportsCapability(entry)) {
    return { gap: { kind: "unsupported-capability", entry } };
  }

  for (const secret of entry.secretRequirements) {
    if (!(await ttsSecretResolves(secret.credentialStoreKey))) {
      return { gap: { kind: "missing-credentials", entry, secret } };
    }
  }

  if (entry.id === "fish-audio" && !fishAudioReferenceIdConfigured()) {
    return { gap: { kind: "missing-fish-audio-reference-id", entry } };
  }

  return { gap: null, entry };
}

/**
 * Whether the fish-audio `referenceId` is configured.
 *
 * Single source of truth for the fish-audio usability invariant: the
 * telephony path supplies no per-request voiceId, so synthesis requires a
 * configured reference ID. Shared by {@link evaluateTelephonyTtsPlayability}
 * and the call TTS resolver's non-WAV degrade path.
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

/**
 * Check whether a TTS catalog `credentialStoreKey` resolves to a value.
 *
 * API keys (`credential/{service}/api_key` or a bare service name) go
 * through `getProviderKeyAsync` so env-var-only setups are honoured;
 * other namespaced fields are looked up verbatim. Shared by
 * {@link evaluateTelephonyTtsPlayability} and the live-voice credential
 * preflight.
 */
export async function ttsSecretResolves(
  credentialStoreKey: string,
): Promise<boolean> {
  const parts = credentialStoreKey.split("/");
  if (parts.length === 1) {
    return Boolean(await getProviderKeyAsync(credentialStoreKey));
  }
  if (
    parts.length === 3 &&
    parts[0] === "credential" &&
    parts[2] === "api_key"
  ) {
    return Boolean(await getProviderKeyAsync(parts[1]));
  }
  return Boolean(await getSecureKeyAsync(credentialStoreKey));
}

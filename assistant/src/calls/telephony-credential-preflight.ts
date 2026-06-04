/**
 * Credential-compatibility preflight for media-stream telephony calls.
 *
 * On the media-stream call path the daemon performs BOTH speech-to-text and
 * text-to-speech itself (Twilio ConversationRelay used to do this with its own
 * managed providers, so no caller credentials were required). Once a call runs
 * over `<Connect><Stream>`, the configured STT and TTS providers must have real,
 * usable credentials or the call connects and then sits silent — the daemon
 * cannot transcribe the caller and cannot synthesize a reply.
 *
 * This module turns "are the configured STT + TTS providers actually able to
 * run a media-stream call?" into one explicit, testable decision via
 * {@link resolveTelephonyCredentialReadiness}.
 *
 * ## Contract
 *
 * Readiness requires BOTH:
 *   1. **STT** — the configured `services.stt.provider` is telephony-eligible
 *      and has a usable credential under the SAME lookup its resolver uses
 *      (`getProviderKeyAsync(entry.credentialProvider)` via the STT provider
 *      catalog). This is the boundary the media-stream STT session will use
 *      (`daemon-streaming` for realtime-ws providers, `daemon-batch` for
 *      batch-only providers) — both are gated by the catalog's `telephonyMode`.
 *   2. **TTS** — the configured `services.tts.provider` can feed the
 *      media-stream PCM -> mu-law transcoder per
 *      {@link resolveTelephonyTtsCapability} (playable format + credential +
 *      required config). The TTS credential probe is NOT re-implemented here:
 *      it is fully delegated to the merged `telephony-tts-capability` helpers
 *      (`resolveTelephonyTtsCapability`, `isTtsProviderCredentialAvailable`),
 *      whose probes are adapter-accurate per provider.
 *
 * ## Fallback
 *
 * A managed/credentialed substitute provider is only ever accepted when it is
 * **actually configured AND verified ready by this same preflight**. For TTS,
 * that means the configured provider OR the verified-ready PCM-capable default
 * ({@link DEFAULT_PLAYABLE_TTS_PROVIDER}) — mirroring
 * {@link resolvePlayableCallTtsProvider}. No default lacking a verified
 * credential is ever invented. STT has no default substitute, so a missing STT
 * credential is always not-ready.
 *
 * ## Not-ready behavior (enforced by the call ingress/setup callers)
 *
 * - **Outbound** (`call-domain.ts`): fail BEFORE placing the Twilio call. Write
 *   a user-facing setup-pointer message to the originating conversation naming
 *   the missing provider credential, record `telephony_credential_preflight_failed`,
 *   and do not place the call.
 * - **Inbound** (`media-stream-server.ts` `handleStart`): the media-stream is
 *   already connected, so speak a short "setup required" message via the normal
 *   media-stream TTS path, record `telephony_credential_preflight_failed`, then
 *   end the call. Never connect-and-sit-silent.
 */

import {
  resolveTelephonySttCapability,
  type TelephonySttCapability,
} from "../providers/speech-to-text/resolve.js";
import { getLogger } from "../util/logger.js";
import {
  DEFAULT_PLAYABLE_TTS_PROVIDER,
  resolveTelephonyTtsCapability,
  resolveTelephonyTtsCapabilityFor,
} from "./telephony-tts-capability.js";

const log = getLogger("telephony-credential-preflight");

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Why a missing credential blocks a media-stream call. */
export type TelephonyCredentialMissingReason =
  | "missing-credentials"
  | "unsupported-provider"
  | "unconfigured-provider"
  | "not-playable";

/** A single provider whose credential/playability blocks the call. */
export interface TelephonyCredentialGap {
  /** Which leg of the pipeline is missing a usable credential. */
  kind: "stt" | "tts";
  /** Provider id, or `null` when the configured provider is unknown. */
  providerId: string | null;
  /** Machine-readable reason the provider is not usable. */
  reason: TelephonyCredentialMissingReason;
}

/** Result of {@link resolveTelephonyCredentialReadiness}. */
export type TelephonyCredentialReadiness =
  | { status: "ready" }
  | { status: "not-ready"; missing: TelephonyCredentialGap[] };

// ---------------------------------------------------------------------------
// STT readiness
// ---------------------------------------------------------------------------

/**
 * Map an STT telephony capability to a preflight gap, or `null` when ready.
 *
 * The credential check is delegated to {@link resolveTelephonySttCapability},
 * which reads the key via `getProviderKeyAsync(entry.credentialProvider)` —
 * the exact lookup the streaming/batch transcriber resolvers use — so the probe
 * cannot disagree with the adapter at call time.
 */
function sttCapabilityToGap(
  capability: TelephonySttCapability,
): TelephonyCredentialGap | null {
  switch (capability.status) {
    case "supported":
      return null;
    case "missing-credentials":
      return {
        kind: "stt",
        providerId: capability.providerId,
        reason: "missing-credentials",
      };
    case "unsupported":
      return {
        kind: "stt",
        providerId: capability.providerId,
        reason: "unsupported-provider",
      };
    case "unconfigured":
      return { kind: "stt", providerId: null, reason: "unconfigured-provider" };
  }
}

// ---------------------------------------------------------------------------
// TTS readiness
// ---------------------------------------------------------------------------

/**
 * Resolve the TTS gap for the media-stream path, or `null` when ready.
 *
 * Mirrors {@link resolvePlayableCallTtsProvider}: the configured provider is
 * accepted when playable; otherwise the PCM-capable default is accepted ONLY
 * when it is itself verified playable (credentialed + required config). This is
 * the only fallback — no uncredentialed substitute is ever invented. When
 * neither is playable, the configured provider's gap is reported.
 */
async function resolveTtsGap(): Promise<TelephonyCredentialGap | null> {
  const configured = await resolveTelephonyTtsCapability();
  if (configured.status === "playable") return null;

  const fallback = await resolveTelephonyTtsCapabilityFor(
    DEFAULT_PLAYABLE_TTS_PROVIDER,
  );
  if (fallback.status === "playable") {
    log.warn(
      {
        configuredProvider: configured.providerId,
        configuredReason: configured.reason,
        fallbackProvider: DEFAULT_PLAYABLE_TTS_PROVIDER,
      },
      "Configured telephony TTS provider not playable — a verified-ready " +
        "PCM-capable default is available, so the call may proceed via fallback",
    );
    return null;
  }

  return {
    kind: "tts",
    providerId: configured.providerId,
    reason:
      configured.reason === "missing-credentials"
        ? "missing-credentials"
        : "not-playable",
  };
}

// ---------------------------------------------------------------------------
// Transport gate
// ---------------------------------------------------------------------------
//
// The outbound transport gate lives in `twilio-routes.ts` as
// `outboundWillUseMediaStream(session)`, NOT here, because it must mirror the
// FULL transport decision `buildVoiceWebhookTwiml` makes — both the STT routing
// strategy AND the `routeSetup` outcome (interactive flows that CR-fall-back
// must skip the preflight). Sharing the predicate with the TwiML builder keeps
// the gate and the real transport branch from drifting. See that helper's
// doc comment (and its PR 11 simplification note) for details.

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate that the configured STT and TTS providers both have usable
 * credentials/playability before a media-stream call proceeds.
 *
 * Returns `{ status: "ready" }` only when STT is telephony-eligible and
 * credentialed AND TTS is playable (configured provider or a verified-ready
 * default). Otherwise returns `{ status: "not-ready"; missing }` listing every
 * provider gap, so callers can name each missing credential to the user.
 */
export async function resolveTelephonyCredentialReadiness(): Promise<TelephonyCredentialReadiness> {
  const [sttCapability, ttsGap] = await Promise.all([
    resolveTelephonySttCapability(),
    resolveTtsGap(),
  ]);

  const missing: TelephonyCredentialGap[] = [];
  const sttGap = sttCapabilityToGap(sttCapability);
  if (sttGap) missing.push(sttGap);
  if (ttsGap) missing.push(ttsGap);

  if (missing.length > 0) {
    return { status: "not-ready", missing };
  }
  return { status: "ready" };
}

/**
 * Human-readable, single-line summary of the missing credentials for use in
 * user-facing setup-pointer copy and spoken setup-required prompts.
 *
 * Example: `speech-to-text provider "openai-whisper" (missing-credentials),
 * text-to-speech provider "elevenlabs" (missing-credentials)`.
 */
export function describeCredentialGaps(
  missing: readonly TelephonyCredentialGap[],
): string {
  return missing
    .map((gap) => {
      const leg = gap.kind === "stt" ? "speech-to-text" : "text-to-speech";
      const provider = gap.providerId
        ? `"${gap.providerId}"`
        : "(unconfigured)";
      return `${leg} provider ${provider} (${gap.reason})`;
    })
    .join(", ");
}

/**
 * Telephony credential-readiness preflight.
 *
 * Transport contract: the daemon performs both telephony legs itself —
 * Twilio only carries mu-law audio frames — so a call can only work when
 * the user holds credentials for a telephony-capable STT provider AND a
 * media-stream-playable TTS provider (the configured one, or a
 * credentialed playable fallback from the catalog).
 *
 * This resolver combines the two capability resolvers into a single
 * ready / not-ready verdict with a user-facing message suitable for both a
 * call-tool error result and TwiML <Say> copy. It creates no provider
 * instances and performs no call-site wiring — callers gate outbound call
 * placement and inbound TwiML on the verdict.
 */

import { getConfig } from "../config/loader.js";
import { effectiveSttProvider } from "../config/schemas/stt.js";
import type { TelephonySttCapability } from "../providers/speech-to-text/resolve.js";
import { resolveTelephonySttCapability } from "../providers/speech-to-text/resolve.js";
import { findPlayableTelephonyTtsFallback } from "./resolve-call-tts-provider.js";
import type { TelephonyTtsNotPlayableReason } from "./telephony-tts-capability.js";
import { resolveTelephonyTtsCapability } from "./telephony-tts-capability.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single credential/capability gap blocking telephony readiness. */
export interface TelephonyCredentialGap {
  kind: "stt" | "tts";
  providerId: string;
  reason: string;
}

/** Result of resolving whether telephony STT+TTS credentials are in order. */
export type TelephonyCredentialReadiness =
  | { status: "ready" }
  | {
      status: "not-ready";
      missing: TelephonyCredentialGap[];
      /**
       * A single human-readable sentence naming the offending provider(s)
       * and missing credential(s), suitable for both a tool error result
       * and TwiML <Say> copy.
       */
      userMessage: string;
    };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve whether the daemon can run both legs of a phone call.
 *
 * Readiness requires:
 * - STT: `resolveTelephonySttCapability()` returns `"supported"`.
 * - TTS: `resolveTelephonyTtsCapability()` returns `"playable"`, or a
 *   credentialed playable fallback provider exists
 *   ({@link findPlayableTelephonyTtsFallback}) — the call TTS resolver
 *   swaps in that fallback at synthesis time, so readiness is satisfied
 *   even when the configured provider is not playable.
 */
export async function resolveTelephonyCredentialReadiness(): Promise<TelephonyCredentialReadiness> {
  const [stt, tts] = await Promise.all([
    resolveTelephonySttCapability(),
    resolveTelephonyTtsCapability(),
  ]);

  const missing: TelephonyCredentialGap[] = [];
  const clauses: string[] = [];

  if (stt.status !== "supported") {
    const providerId =
      "providerId" in stt
        ? stt.providerId
        : effectiveSttProvider(getConfig().services.stt);
    missing.push({ kind: "stt", providerId, reason: stt.reason });
    clauses.push(sttGapClause(stt, providerId));
  }

  if (tts.status === "not-playable") {
    const fallbackId = await findPlayableTelephonyTtsFallback(tts.providerId);
    if (!fallbackId) {
      const { gap, clause } = ttsGap(tts.providerId, tts.reason);
      missing.push(gap);
      clauses.push(clause);
    }
  }

  if (missing.length === 0) {
    return { status: "ready" };
  }

  return {
    status: "not-ready",
    missing,
    userMessage: `Phone calls are unavailable because they require ${clauses.join(" and ")}.`,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** User-message clause for an STT capability gap. */
function sttGapClause(
  capability: Exclude<TelephonySttCapability, { status: "supported" }>,
  providerId: string,
): string {
  switch (capability.status) {
    case "missing-credentials": {
      return `an API key for the speech-to-text provider "${providerId}"`;
    }
    case "unsupported": {
      return `a speech-to-text provider that supports phone calls (the configured "${providerId}" does not)`;
    }
    case "unconfigured": {
      return `a recognized speech-to-text provider (the configured "${providerId}" is not in the provider catalog)`;
    }
  }
}

/** Gap entry and user-message clause for a TTS playability gap with no usable fallback. */
function ttsGap(
  providerId: string,
  reason: TelephonyTtsNotPlayableReason,
): { gap: TelephonyCredentialGap; clause: string } {
  switch (reason) {
    case "missing-credentials": {
      return {
        gap: {
          kind: "tts",
          providerId,
          reason: `TTS provider "${providerId}" is missing credentials and no playable fallback provider is available`,
        },
        clause: `an API key for the text-to-speech provider "${providerId}" (no fallback provider has usable credentials)`,
      };
    }
    case "missing-fish-audio-reference-id": {
      return {
        gap: {
          kind: "tts",
          providerId,
          reason: `TTS provider "${providerId}" has no Fish Audio reference ID configured (services.tts.providers.fish-audio.referenceId) and no playable fallback provider is available`,
        },
        clause: `a Fish Audio voice reference ID for the text-to-speech provider "${providerId}" (set services.tts.providers.fish-audio.referenceId; no fallback provider is usable)`,
      };
    }
    case "unsupported-format": {
      return {
        gap: {
          kind: "tts",
          providerId,
          reason: `TTS provider "${providerId}" cannot produce media-stream-playable audio and no playable fallback provider is available`,
        },
        clause: `a text-to-speech provider that can produce call audio (the configured "${providerId}" cannot, and no fallback provider is usable)`,
      };
    }
  }
}

/**
 * Live-voice credential-readiness preflight.
 *
 * A live voice session needs the daemon to run both audio legs: streaming
 * speech-to-text for caller audio, and streaming text-to-speech for
 * assistant audio. This resolver combines the two checks into a single
 * ready / not-ready verdict with a user-facing message suitable for the
 * client `error` frame, so a session fails at the `start` frame instead of
 * mid-conversation. It opens no live connections and performs no session
 * wiring — the session gates startup on the verdict. Mirrors
 * `calls/telephony-credential-preflight.ts` for the phone-call transport.
 */

import {
  fishAudioReferenceIdConfigured,
  ttsSecretResolves,
} from "../calls/telephony-tts-capability.js";
import { getConfig } from "../config/loader.js";
import { managedSpeechAvailable } from "../platform/managed-speech.js";
import { effectiveSttProvider } from "../config/schemas/stt.js";
import { getProviderEntry } from "../providers/speech-to-text/provider-catalog.js";
import {
  resolveStreamingTranscriber,
  sttCredentialGapReason,
  sttProviderKeyResolves,
} from "../providers/speech-to-text/resolve.js";
import type { SttProviderId } from "../stt/types.js";
import type { TtsProviderCatalogEntry } from "../tts/provider-catalog.js";
import { getCatalogProvider, getTtsProvider } from "../tts/provider-catalog.js";
import { resolveTtsConfig } from "../tts/tts-config-resolver.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single credential/capability gap blocking live-voice readiness. */
export interface LiveVoiceCredentialGap {
  kind: "stt" | "tts";
  providerId: string;
  reason: string;
}

/** Result of resolving whether live-voice STT+TTS credentials are in order. */
export type LiveVoiceCredentialReadiness =
  | { status: "ready" }
  | {
      status: "not-ready";
      missing: LiveVoiceCredentialGap[];
      /**
       * A single human-readable sentence naming the offending provider(s)
       * and missing credential(s), suitable for the client `error` frame.
       */
      userMessage: string;
    };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve whether the daemon can run both audio legs of a live voice
 * session.
 *
 * Readiness requires:
 * - STT: the configured `services.stt.provider` resolves a streaming
 *   transcriber (the session arms one per utterance — there is no batch
 *   fallback on the live-voice transport).
 * - TTS: the configured `services.tts.provider` supports streaming
 *   synthesis (`synthesizeStream`), all of its required secrets resolve,
 *   and provider-specific config invariants hold (fish-audio requires a
 *   configured `referenceId` — live voice supplies no per-request voiceId).
 */
export async function resolveLiveVoiceCredentialReadiness(): Promise<LiveVoiceCredentialReadiness> {
  const gaps = (await Promise.all([resolveSttGap(), resolveTtsGap()])).filter(
    (gap) => gap !== null,
  );

  if (gaps.length === 0) {
    return { status: "ready" };
  }

  return {
    status: "not-ready",
    missing: gaps.map(({ gap }) => gap),
    userMessage: `Live voice is unavailable because it requires ${gaps
      .map(({ clause }) => clause)
      .join(" and ")}.`,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** A gap entry plus its user-message clause. */
interface GapWithClause {
  gap: LiveVoiceCredentialGap;
  clause: string;
}

/**
 * Resolve the STT leg: no gap when the configured provider yields a
 * streaming transcriber. When none resolves, classify why so the gap
 * names the missing piece.
 */
async function resolveSttGap(): Promise<GapWithClause | null> {
  if ((await resolveStreamingTranscriber()) !== null) {
    return null;
  }

  const providerId = effectiveSttProvider(getConfig().services.stt);
  const entry = getProviderEntry(providerId as SttProviderId);
  if (!entry) {
    return {
      gap: {
        kind: "stt",
        providerId,
        reason: `STT provider "${providerId}" is not in the provider catalog`,
      },
      clause: `a recognized speech-to-text provider (the configured "${providerId}" is not in the provider catalog)`,
    };
  }

  if (!(await sttProviderKeyResolves(entry.credentialProvider))) {
    return {
      gap: {
        kind: "stt",
        providerId: entry.id,
        reason: sttCredentialGapReason(entry.credentialProvider),
      },
      clause:
        entry.credentialProvider === "vellum"
          ? `a Vellum platform connection for managed speech (run 'assistant platform connect')`
          : `an API key for the speech-to-text provider "${entry.id}"`,
    };
  }

  return {
    gap: {
      kind: "stt",
      providerId: entry.id,
      reason: `STT provider "${entry.id}" does not support streaming transcription`,
    },
    clause: `a speech-to-text provider that supports live transcription (the configured "${entry.id}" does not)`,
  };
}

/**
 * Resolve the TTS leg: no gap when the configured provider supports
 * streaming synthesis, every secret its catalog entry requires resolves
 * to a value, and fish-audio (which live voice drives without a
 * per-request voiceId) has a configured `referenceId`.
 */
async function resolveTtsGap(): Promise<GapWithClause | null> {
  const { provider: providerId } = resolveTtsConfig(getConfig());

  let entry: TtsProviderCatalogEntry;
  try {
    entry = getCatalogProvider(providerId);
  } catch {
    return {
      gap: {
        kind: "tts",
        providerId,
        reason: `TTS provider "${providerId}" is not in the provider catalog`,
      },
      clause: `a recognized text-to-speech provider (the configured "${providerId}" is not in the provider catalog)`,
    };
  }

  const adapter = getTtsProvider(entry.id);
  if (
    !adapter.capabilities.supportsStreaming ||
    typeof adapter.synthesizeStream !== "function"
  ) {
    return {
      gap: {
        kind: "tts",
        providerId: entry.id,
        reason: `TTS provider "${entry.id}" does not support streaming synthesis`,
      },
      clause: `a text-to-speech provider that supports streaming synthesis (the configured "${entry.id}" does not)`,
    };
  }

  // Managed speech authenticates via the platform connection — full
  // availability (API key + assistant ID) is the credential, so the
  // stored-secret loop below would pass half-connected states that
  // synthesis rejects.
  if (entry.id === "vellum") {
    if (!(await managedSpeechAvailable())) {
      return {
        gap: {
          kind: "tts",
          providerId: entry.id,
          reason: `TTS provider "${entry.id}" needs a Vellum platform connection for managed speech`,
        },
        clause: `a Vellum platform connection for managed speech (run 'assistant platform connect')`,
      };
    }
    return null;
  }

  for (const secret of entry.secretRequirements) {
    if (!(await ttsSecretResolves(secret.credentialStoreKey))) {
      return {
        gap: {
          kind: "tts",
          providerId: entry.id,
          reason: `TTS provider "${entry.id}" is missing credentials (${secret.displayName})`,
        },
        clause: `an API key for the text-to-speech provider "${entry.id}" (${secret.displayName})`,
      };
    }
  }

  if (entry.id === "fish-audio" && !fishAudioReferenceIdConfigured()) {
    return {
      gap: {
        kind: "tts",
        providerId: entry.id,
        reason: `TTS provider "${entry.id}" has no Fish Audio reference ID configured (services.tts.providers.fish-audio.referenceId)`,
      },
      clause: `a Fish Audio voice reference ID for the text-to-speech provider "${entry.id}" (set services.tts.providers.fish-audio.referenceId)`,
    };
  }

  return null;
}

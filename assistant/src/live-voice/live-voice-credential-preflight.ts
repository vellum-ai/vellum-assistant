/**
 * Live-voice credential-readiness preflight.
 *
 * A live voice session needs the daemon to run both audio legs: streaming
 * (or per-turn batch fallback) speech-to-text for caller audio, and
 * streaming text-to-speech for assistant audio. This resolver combines the
 * two checks into a single ready / not-ready verdict with a user-facing
 * message suitable for the client `error` frame, so a session fails at
 * start instead of mid-conversation. It opens no live connections and
 * performs no session wiring — the session composition root gates startup
 * on the verdict. Mirrors `calls/telephony-credential-preflight.ts` for
 * the phone-call transport, sharing its gap/readiness shapes and the
 * TTS-provider gap skeleton (`findTtsProviderGap`); only the capability
 * predicates differ (streaming synthesis here, media-stream playability
 * there).
 *
 * The STT leg attempts the exact tiers the ingest uses at runtime
 * ({@link resolveTieredStreamingTranscriber}: utterance-boundary finals,
 * then plain streaming), then the batch fallback, so ready/not-ready
 * matches what a session would actually resolve.
 */

import type {
  TelephonyCredentialGap,
  TelephonyCredentialReadiness,
} from "../calls/telephony-credential-preflight.js";
import { findTtsProviderGap } from "../calls/telephony-tts-capability.js";
import { getConfig } from "../config/loader.js";
import { getProviderEntry } from "../providers/speech-to-text/provider-catalog.js";
import {
  resolveBatchTranscriber,
  resolveStreamingTranscriber,
  sttProviderKeyResolves,
} from "../providers/speech-to-text/resolve.js";
import type { SttProviderId } from "../stt/types.js";
import { getTtsProvider } from "../tts/provider-catalog.js";
import { resolveTtsConfig } from "../tts/tts-config-resolver.js";
import { resolveTieredStreamingTranscriber } from "./live-voice-ingest.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single credential/capability gap blocking live-voice readiness.
 * Structurally shared with the telephony preflight — the two transports
 * report gaps identically.
 */
export type LiveVoiceCredentialGap = TelephonyCredentialGap;

/**
 * Result of resolving whether live-voice STT+TTS credentials are in order.
 * Structurally shared with the telephony preflight; the `userMessage` is a
 * single human-readable sentence suitable for the client `error` frame.
 */
export type LiveVoiceCredentialReadiness = TelephonyCredentialReadiness;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve whether the daemon can run both audio legs of a live voice
 * session.
 *
 * Readiness requires:
 * - STT: the configured `services.stt.provider` resolves a streaming
 *   transcriber on either tier the ingest uses (boundary finals, then
 *   plain streaming), or — acceptable fallback mode — a batch transcriber.
 * - TTS: the configured `services.tts.provider` supports streaming
 *   synthesis (`synthesizeStream`), all of its required secrets resolve,
 *   and provider-specific invariants hold (fish-audio needs a configured
 *   `referenceId`, or `synthesizeStream` fails on the first response).
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
 * Resolve the STT leg: no gap when the configured provider resolves a
 * streaming transcriber on either runtime tier, or (batch-fallback mode) a
 * batch transcriber. When nothing resolves, classify why so the gap names
 * the missing piece.
 */
async function resolveSttGap(): Promise<GapWithClause | null> {
  if (
    (await resolveTieredStreamingTranscriber(resolveStreamingTranscriber)) !==
    null
  ) {
    return null;
  }
  if ((await resolveBatchTranscriber()) !== null) {
    return null;
  }

  const providerId = getConfig().services.stt.provider;
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
        reason: `No API key configured for credential provider "${entry.credentialProvider}"`,
      },
      clause: `an API key for the speech-to-text provider "${entry.id}"`,
    };
  }

  return {
    gap: {
      kind: "stt",
      providerId: entry.id,
      reason: `STT provider "${entry.id}" supports neither streaming nor batch transcription`,
    },
    clause: `a speech-to-text provider that supports live transcription (the configured "${entry.id}" does not)`,
  };
}

/**
 * Resolve the TTS leg via the shared provider-gap skeleton
 * ({@link findTtsProviderGap}): no gap when the configured provider
 * supports streaming synthesis, every required secret resolves, and the
 * fish-audio `referenceId` invariant holds.
 */
async function resolveTtsGap(): Promise<GapWithClause | null> {
  const { provider: providerId } = resolveTtsConfig(getConfig());

  const result = await findTtsProviderGap(providerId, (entry) => {
    const adapter = getTtsProvider(entry.id);
    return (
      adapter.capabilities.supportsStreaming &&
      typeof adapter.synthesizeStream === "function"
    );
  });
  if (result.gap === null) {
    return null;
  }

  switch (result.gap.kind) {
    case "unknown-provider":
      return {
        gap: {
          kind: "tts",
          providerId,
          reason: `TTS provider "${providerId}" is not in the provider catalog`,
        },
        clause: `a recognized text-to-speech provider (the configured "${providerId}" is not in the provider catalog)`,
      };
    case "unsupported-capability": {
      const { id } = result.gap.entry;
      return {
        gap: {
          kind: "tts",
          providerId: id,
          reason: `TTS provider "${id}" does not support streaming synthesis`,
        },
        clause: `a text-to-speech provider that supports streaming synthesis (the configured "${id}" does not)`,
      };
    }
    case "missing-credentials": {
      const { id } = result.gap.entry;
      const { displayName } = result.gap.secret;
      return {
        gap: {
          kind: "tts",
          providerId: id,
          reason: `TTS provider "${id}" is missing credentials (${displayName})`,
        },
        clause: `an API key for the text-to-speech provider "${id}" (${displayName})`,
      };
    }
    case "missing-fish-audio-reference-id": {
      const { id } = result.gap.entry;
      return {
        gap: {
          kind: "tts",
          providerId: id,
          reason: `TTS provider "${id}" has no Fish Audio reference ID configured (services.tts.providers.fish-audio.referenceId)`,
        },
        clause: `a Fish Audio voice reference ID for the text-to-speech provider "${id}" (set services.tts.providers.fish-audio.referenceId)`,
      };
    }
  }
}

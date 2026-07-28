import { livevoicePreflightPost } from "@/generated/daemon/sdk.gen";
import type { LivevoicePreflightPostResponse } from "@/generated/daemon/types.gen";

/**
 * The parsed readiness verdict from `POST /v1/live-voice/preflight`.
 *
 * `ready` → the daemon has a usable STT and TTS provider (managed defaulting
 * has already run server-side) and the live-voice room can be opened.
 * `not-ready` → no usable provider; `missing` lists what's absent and
 * `userMessage` carries the human-readable "configure voice" copy to surface.
 */
export type LiveVoicePreflightVerdict = LivevoicePreflightPostResponse;

/**
 * POST /v1/live-voice/preflight
 *
 * Imperative one-shot call made at voice-entry time (NOT a long-lived query):
 * the daemon runs `maybeDefaultSpeechToManaged()` then reports whether live
 * voice can start. The composer awaits this before opening the room so it
 * never flashes open then immediately closes for a user with no usable
 * STT/TTS provider.
 *
 * Returns `null` when the call itself fails (network/daemon error) so the
 * caller can decide how to degrade — the composer fails OPEN on `null` so a
 * preflight outage never blocks voice entirely (the WS-level start handshake
 * still surfaces any real credential problem).
 *
 * Mirrors the imperative daemon-call shape in `postDictation`.
 */
export async function preflightLiveVoice(
  assistantId: string,
  signal?: AbortSignal,
): Promise<LiveVoicePreflightVerdict | null> {
  try {
    const { data, response } = await livevoicePreflightPost({
      path: { assistant_id: assistantId },
      throwOnError: false,
      signal,
    });
    if (!response || !response.ok || !data) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

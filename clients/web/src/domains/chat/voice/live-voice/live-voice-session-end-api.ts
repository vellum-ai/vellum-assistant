import { livevoiceSessionEndPost } from "@/generated/daemon/sdk.gen";

/**
 * POST /v1/live-voice/session/end
 *
 * Ends whichever live-voice session holds the assistant's single slot, from
 * outside that session's own transport. The in-band `end` frame needs a
 * working socket, and the session a user most needs ended is the one whose
 * socket is already gone, which is why this exists as an HTTP call.
 *
 * Returns whether a session was actually ended. `false` covers both "nothing
 * was running" and "the call failed", because the caller does the same thing
 * either way: try to start, and let the start handshake report anything still
 * wrong. Nothing here is worth a second error surface in front of a user who
 * is trying to get out of the first one.
 *
 * Mirrors the imperative daemon-call shape in `preflightLiveVoice`.
 */
export async function endLiveVoiceSessionOnAssistant(
  assistantId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const { data, response } = await livevoiceSessionEndPost({
      path: { assistant_id: assistantId },
      throwOnError: false,
      signal,
    });
    if (!response || !response.ok || !data) {
      return false;
    }
    return data.ended;
  } catch {
    return false;
  }
}

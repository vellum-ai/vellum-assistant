/**
 * The two checks that stand between "the user asked to talk" and a session
 * opening, in one place so every entry point runs the same ones.
 *
 * There are three entry points and they do not share a component: the
 * composer's voice button, the voice mode shortcut, and the companion
 * surface's Talk. The guards used to live inside the composer, which meant
 * the two that reach voice from outside it started sessions the composer
 * would have refused: a user with no usable provider got a room that opened
 * and closed, and a first-ever entry skipped the preferences card that is
 * supposed to precede it.
 *
 * Both guards publish to the live-voice store rather than returning something
 * to render, because the surface that asks is not always the surface that
 * shows the answer. A shortcut pressed on the settings page is answered by a
 * card in the chat window it navigates to.
 */

import { preflightLiveVoice } from "@/domains/chat/voice/live-voice/live-voice-preflight-api";
import { useLiveVoiceStore } from "@/domains/chat/voice/live-voice/live-voice-store";
import { useVoicePrefsStore } from "@/stores/voice-prefs-store";

/** Fallback when a `not-ready` verdict carries no `userMessage`. */
const DEFAULT_CONFIG_NOTICE =
  "Voice isn't set up yet. Configure a voice provider to start talking.";

/**
 * Whether the first-run preferences card takes this entry.
 *
 * The first ever voice entry opens the card instead of a session, so the user
 * chooses their transcript preferences before anything starts listening. The
 * card commits the choice and starts; a plain dismiss cancels without
 * consuming the first run, so it returns on the next entry.
 *
 * Returns `true` when the caller should stop, having handed the entry over.
 */
export function firstRunCardIntercepts(): boolean {
  if (useVoicePrefsStore.getState().firstRunSeen) {
    return false;
  }
  useLiveVoiceStore.getState().setFirstRunCardOpen(true);
  return true;
}

/**
 * The daemon's answer to "can a session open", with the copy to show if not.
 *
 * Split from publishing it because the caller decides *whether the answer is
 * still wanted*: the composer re-checks that the user has not navigated to
 * another chat across the await, and a notice published regardless would
 * surface against whatever thread they moved to.
 *
 * **Allows on a null verdict** (a preflight network or daemon error): an
 * outage must not block voice entirely. Only an explicit `not-ready` closes
 * the door; a real credential problem still surfaces through the WS start
 * handshake's failure notice.
 *
 * Gating at all is what keeps the room from flashing open and closing for a
 * user with no usable STT/TTS provider. The daemon runs managed-speech
 * defaulting as part of this call, so a user who *can* be auto-configured
 * comes back allowed.
 */
export async function voiceReadiness(
  assistantId: string,
): Promise<{ allowed: boolean; notice: string | null }> {
  const verdict = await preflightLiveVoice(assistantId);
  if (verdict?.status === "not-ready") {
    return {
      allowed: false,
      notice: verdict.userMessage ?? DEFAULT_CONFIG_NOTICE,
    };
  }
  return { allowed: true, notice: null };
}

/**
 * Show (or clear) the pre-open "configure voice" notice. `null` clears, which
 * is what a start that got past readiness does to any notice left from a
 * previous attempt.
 */
export function publishConfigNotice(notice: string | null): void {
  useLiveVoiceStore.getState().setConfigNotice(notice);
}

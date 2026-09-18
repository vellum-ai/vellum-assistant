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
 *
 * Both are also synchronous up to the point they decide, because the press
 * they decide about carries the microphone and playback permissions the
 * session needs, and those are spent from the gesture rather than from a
 * callback the gesture eventually reaches.
 */

import { preflightLiveVoice } from "@/domains/chat/voice/live-voice/live-voice-preflight-api";
import { useLiveVoiceStore } from "@/domains/chat/voice/live-voice/live-voice-store";
import { companionIntroStaged } from "@/runtime/companion-intro-stage";
import { useVoicePrefsStore } from "@/stores/voice-prefs-store";

/** Fallback when a `not-ready` verdict carries no `userMessage`. */
const DEFAULT_CONFIG_NOTICE =
  "Voice isn't set up yet. Configure a voice provider to start talking.";

/**
 * Whether the first-run preferences card takes this entry.
 *
 * The first ever voice entry opens the card instead of a session, so the user
 * meets the room before it starts listening. The card commits and starts; a
 * plain dismiss cancels without consuming the first run, so it returns on the
 * next entry.
 *
 * **Except during the companion's introduction, which is already saying this.**
 * The run's eight cards end on an offer of a real conversation, taken either by
 * pressing the creature or by double tapping the voice key, and its `talk` and
 * `mute` beats have just taught the two things this card's bullets teach. Drawn
 * on top of that, the card is a third gate on the one press the whole run was
 * building to, repeating the run in the run's own window. The introduction is
 * the more specific surface and it is the one the user is looking at, so it
 * wins and the entry goes straight through.
 *
 * Standing down still spends the first run. The user is about to have the
 * conversation the card exists to precede, so a card waiting for them on the
 * next entry would be an introduction to something already done. Nothing is
 * decided on their behalf by skipping it: the card writes no preference of its
 * own (transcripts stay off, which is where they rest for everyone), and the
 * two settings reachable from it, the assistant's voice and the listening
 * language, are untouched defaults that live on in Settings and in the room's
 * own in-session settings.
 *
 * Spent on the press rather than on the session that follows it, which is what
 * the card's own Start already does: the composer marks the run seen and then
 * runs readiness, so a `not-ready` verdict has always spent it. The first run
 * is about whether the user has been introduced, not about whether a session
 * managed to open.
 *
 * `duringCompanionIntro` defaults to asking now, which is what a press decided
 * on the spot wants. A caller that decides later passes the answer it read at
 * press time instead: the last beat's `try` ends the run in the same breath as
 * it asks for the session, so "is a run on" stops being true within the gap,
 * and the press still came out of one. See {@link drainPendingVoiceStart}.
 *
 * Returns `true` when the caller should stop, having handed the entry over.
 */
export function firstRunCardIntercepts(
  duringCompanionIntro: boolean = companionIntroStaged(),
): boolean {
  if (useVoicePrefsStore.getState().firstRunSeen) {
    return false;
  }
  if (duringCompanionIntro) {
    useVoicePrefsStore.getState().markFirstRunSeen();
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

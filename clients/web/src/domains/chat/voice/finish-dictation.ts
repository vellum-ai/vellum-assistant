/**
 * Ends an in-flight dictation session and waits for its transcript to land
 * in the composer, so a send can never outrun the words the user is watching
 * themselves say.
 *
 * Dictation shows two texts at once: the committed draft in the textarea and
 * the live partial underneath it. Only the draft is the payload, and nothing
 * on screen says so, so pressing Send mid-utterance used to send whatever the
 * textarea happened to hold and drop everything spoken since (LUM-3432).
 * Awaiting this first makes Send mean "finish, then send", which is the
 * gesture people already reach for at the end of dictating.
 *
 * The transcript is written to the composer by `onTranscript` *before*
 * `finalize()` moves the store to `done`, so a `done` phase is the signal
 * that the words are in the draft and the send can read them.
 */

import { getPushToTalkTarget } from "@/domains/chat/voice/push-to-talk-target";
import {
  useVoiceRecordingStore,
  type VoiceRecordingPhase,
} from "@/domains/chat/voice/voice-recording-store";

export type DictationFinishOutcome =
  /** Nothing was recording or transcribing; the caller can proceed as normal. */
  | "none"
  /** A session finished and put its transcript in the composer. */
  | "delivered"
  /** A session ended without producing text (error, silence, or a wedged stop). */
  | "no-transcript";

function isInFlight(phase: VoiceRecordingPhase): boolean {
  return phase === "recording" || phase === "processing";
}

/**
 * Whether the session in the window-global store is the composer's own. The
 * store is shared with the bridge's hidden recorder, which a held voice key
 * always drives (its words are aimed at a cursor in another app), and every
 * session that recorder opens is flagged `hold` as it starts. What is left
 * once holds are excluded is a press that resolved to the registered target,
 * which on a chat route is the composer's microphone.
 */
function isComposerSession(state: {
  phase: VoiceRecordingPhase;
  hold: boolean;
}): boolean {
  return isInFlight(state.phase) && !state.hold;
}

/**
 * Stop the composer's live dictation, if any, and resolve once it has
 * reached a terminal phase.
 *
 * Callers should proceed only on `"none"` or `"delivered"`. A
 * `"no-transcript"` result means the user pressed Send while speaking and
 * the words did not survive: sending the draft that happens to be sitting
 * there would send something they did not ask for, and the draft is left
 * untouched so they can simply try again.
 *
 * A session the composer does not own (a held key dictating into another
 * app) is `"none"`: it is not content for this composer, and the send goes
 * out with the draft exactly as it would with no microphone open.
 *
 * The wait has no ceiling of its own. Every exit from `processing` is made
 * by the recording button (finalize, fail, or reset, whatever the batch STT
 * round trip does), and a composer session in `recording` leaves it through
 * the stop issued here on the target that owns the recorder. A slow
 * transcription is still a transcription on its way to the draft, so the
 * send waits for it rather than dropping it on a clock.
 */
export async function finishActiveDictation(): Promise<DictationFinishOutcome> {
  const store = useVoiceRecordingStore;
  if (!isComposerSession(store.getState())) {
    return "none";
  }

  if (store.getState().phase === "recording") {
    // The composer's own `VoiceInputButton` registers itself as the target,
    // so this is the instance that owns the recorder for a session that is
    // not a hold.
    getPushToTalkTarget()?.stop();
  }

  const terminalPhase = await new Promise<VoiceRecordingPhase>((resolve) => {
    let unsubscribe: (() => void) | null = null;
    const settle = (phase: VoiceRecordingPhase) => {
      unsubscribe?.();
      unsubscribe = null;
      resolve(phase);
    };

    unsubscribe = store.subscribe((state) => {
      if (!isInFlight(state.phase)) {
        settle(state.phase);
      }
    });

    // `stop()` above can drive the session all the way to a terminal phase
    // before the subscription exists.
    const current = store.getState().phase;
    if (!isInFlight(current)) {
      settle(current);
    }
  });

  return terminalPhase === "done" ? "delivered" : "no-transcript";
}

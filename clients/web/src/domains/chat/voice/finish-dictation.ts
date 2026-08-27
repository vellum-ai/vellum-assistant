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

/**
 * Ceiling on the wait. Generous, because the batch STT round trip owns most
 * of the `processing` phase; hitting it means the session is wedged rather
 * than slow, and the caller drops the send instead of guessing at a payload.
 */
const FINALIZE_TIMEOUT_MS = 10_000;

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
 * Stop any live dictation and resolve once it has reached a terminal phase.
 *
 * Callers should proceed only on `"none"` or `"delivered"`. A
 * `"no-transcript"` result means the user pressed Send while speaking and
 * the words did not survive: sending the draft that happens to be sitting
 * there would send something they did not ask for, and the draft is left
 * untouched so they can simply try again.
 */
export async function finishActiveDictation(
  timeoutMs: number = FINALIZE_TIMEOUT_MS,
): Promise<DictationFinishOutcome> {
  const store = useVoiceRecordingStore;
  if (!isInFlight(store.getState().phase)) {
    return "none";
  }

  if (store.getState().phase === "recording") {
    // The composer's own `VoiceInputButton` registers itself as the target,
    // so this is the instance that owns the recorder in the flow that
    // matters. A press that lands on an instance owning no recorder is a
    // no-op and falls through to the timeout below.
    getPushToTalkTarget()?.stop();
  }

  const terminalPhase = await new Promise<VoiceRecordingPhase | null>(
    (resolve) => {
      let unsubscribe: (() => void) | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const settle = (phase: VoiceRecordingPhase | null) => {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        unsubscribe?.();
        unsubscribe = null;
        resolve(phase);
      };

      unsubscribe = store.subscribe((state) => {
        if (!isInFlight(state.phase)) {
          settle(state.phase);
        }
      });
      timer = setTimeout(() => {
        console.warn("dictation: finalize timed out, send dropped");
        settle(null);
      }, timeoutMs);

      // `stop()` above can drive the session all the way to a terminal phase
      // before the subscription exists.
      const current = store.getState().phase;
      if (!isInFlight(current)) {
        settle(current);
      }
    },
  );

  return terminalPhase === "done" ? "delivered" : "no-transcript";
}

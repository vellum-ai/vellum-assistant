/**
 * The user pressed a control the assistant was pointing at, said to the call
 * as their turn.
 *
 * The assistant walks someone through steps by pointing at each one and
 * waiting. What it waits for is evidence the step is done, and the press on
 * the control it pointed at is the most direct evidence there is. The desktop
 * sees the press; this is where it becomes a turn, so the assistant hears the
 * step is done and says what comes next.
 *
 * The rule and the copy live together, the way the entry greeting's do: the
 * copy is only honest under the rule.
 */

import {
  isLiveVoiceSessionActive,
  useLiveVoiceStore,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import { t } from "@/i18n";

/**
 * Put the press on `label` to the running session as the user's turn.
 * Returns whether it went out.
 *
 * **Visible, not hidden.** The user did press the thing, and a transcript
 * that shows what drove the reply reads right; a reply about the next step
 * hanging off nothing does not. The copy names the control by the label the
 * surface reports, which is the word the assistant was told it had pointed
 * at, so the two agree about which step this is.
 *
 * **Cuts in, and is kept.** A press usually lands while the assistant is
 * still saying the step. A person who saw the step done would stop
 * explaining it, so the press does the same: it cuts the reply off and takes
 * the turn. If the assistant still refuses it (its microphone hearing the
 * speakers holds the floor for a while), nobody is watching a composer for
 * this turn, so the refusal is put again rather than shown.
 *
 * Nothing to say when no session is up: marks only stand on a share, and a
 * share only exists on a call, so this is the press outliving the call.
 */
export function reportCoachmarkPressed(label: string): boolean {
  const store = useLiveVoiceStore.getState();
  if (!isLiveVoiceSessionActive(store.state)) {
    return false;
  }
  return (
    store.starter?.sendText(t("chat:coachmarkPress.turn", { label }), {
      bargeIn: true,
      retryWhenBusy: true,
    }) === true
  );
}

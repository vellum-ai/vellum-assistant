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
  requestLiveVoiceScreenFrame,
  useLiveVoiceStore,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import { liveVoiceCanBeShownTheScreen } from "@/domains/chat/voice/live-voice/screen-share-availability";
import { t } from "@/i18n";

/**
 * How long after the press the screen is taken. The press is seen on the
 * mouse going down; the control acts on it coming up, and the app then has
 * to draw what it did. A frame taken sooner is the screen before the click,
 * which is the view the assistant already has.
 */
export const PRESS_SETTLE_MS = 600;

/**
 * The longest the turn waits for that frame once it is asked for. A capture
 * and an upload are usually well under a second; past this the turn goes
 * without it, and the assistant can still ask to look.
 */
export const PRESS_FRAME_WAIT_MS = 2500;

/**
 * Put the press on `label` to the running session as the user's turn.
 * Resolves whether it went out.
 *
 * **Visible, not hidden.** The user did press the thing, and a transcript
 * that shows what drove the reply reads right; a reply about the next step
 * hanging off nothing does not. The copy names the control by the label the
 * surface reports, which is the word the assistant was told it had pointed
 * at, so the two agree about which step this is.
 *
 * **With the screen it changed.** On a share, the turn waits for a fresh
 * frame taken a beat after the press, so the assistant reads the step it is
 * about to explain off the view the click produced. Without it the newest
 * frame the call has is from before the click (the cadence takes frames on
 * speech, and a click is silent), and the assistant would spend a whole
 * round trip asking to look. No share, no wait.
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
export async function reportCoachmarkPressed(label: string): Promise<boolean> {
  if (!isLiveVoiceSessionActive(useLiveVoiceStore.getState().state)) {
    return false;
  }
  if (sharingScreen()) {
    await new Promise((resolve) => setTimeout(resolve, PRESS_SETTLE_MS));
    // Asked after the settle, not before: the share takes the frame the
    // moment it is asked, and the settle is what makes it the new view.
    await requestLiveVoiceScreenFrame(PRESS_FRAME_WAIT_MS);
  }
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

function sharingScreen(): boolean {
  return (
    useLiveVoiceStore.getState().screenShareTarget !== null &&
    liveVoiceCanBeShownTheScreen()
  );
}

import {
  useCompanionPopoverStore,
  VOICE_START_ACTIONS,
  type VoiceStartConfirmationCopy,
} from "@/domains/chat/companion-popover";
import { getDeviceBool, setDeviceBool } from "@/utils/device-settings";

let answer: ((start: boolean) => void) | null = null;

/**
 * Ask on the companion before the voice key starts a call, so the user answers
 * over whatever app they are in and nothing is raised.
 *
 * The card stays published after an answer until
 * {@link withdrawVoiceShortcutConfirmation}, which the caller runs once it has
 * acted: main holds the companion on screen while the card is published, and a
 * started call takes the surface over from it without the surface closing.
 */
export function confirmVoiceShortcutStart(
  copy: VoiceStartConfirmationCopy,
): Promise<boolean> {
  if (getDeviceBool("voiceStartConfirmationSkipped", false)) {
    return Promise.resolve(true);
  }
  withdrawVoiceShortcutConfirmation();
  useCompanionPopoverStore.setState({ voiceStartConfirmation: copy });
  return new Promise<boolean>((resolve) => {
    answer = resolve;
  });
}

/** A press on the card. Null is its close. */
export function answerVoiceShortcutConfirmation(actionId: string | null): void {
  const resolve = answer;
  if (resolve === null) {
    return;
  }
  answer = null;
  if (actionId === VOICE_START_ACTIONS.always) {
    setDeviceBool("voiceStartConfirmationSkipped", true);
  }
  resolve(
    actionId === VOICE_START_ACTIONS.start ||
      actionId === VOICE_START_ACTIONS.always,
  );
}

/** Take the card down, declining it if it is still unanswered. */
export function withdrawVoiceShortcutConfirmation(): void {
  answerVoiceShortcutConfirmation(null);
  if (useCompanionPopoverStore.getState().voiceStartConfirmation !== null) {
    useCompanionPopoverStore.setState({ voiceStartConfirmation: null });
  }
}

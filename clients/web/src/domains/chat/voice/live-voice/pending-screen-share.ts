/**
 * A share asked for before there was a call to show it to.
 *
 * The keyboard's gesture is one press and means one thing: show the assistant
 * this screen. With no session running that is two errands, a call and a
 * share, and the second cannot be done until the first arrives. So the target
 * waits here for it.
 *
 * What waits is the target main resolved at the press, not the ask that
 * produced it. "The display under the pointer" is a question with a different
 * answer a second later, and the second the user spends waiting for a call to
 * connect is a second their hand can move the mouse in. What they pointed at
 * is what they meant.
 *
 * The wait is bounded by the same clock the start request is: a call that
 * never arrives leaves nothing armed behind it, so a share can never begin on
 * a gesture the user made long enough ago to have forgotten.
 */

import { VOICE_START_REQUEST_TTL_MS } from "@vellumai/ipc-contract";
import type { WatchCaptureTarget } from "@vellumai/ipc-contract";

import {
  isLiveVoiceSessionActive,
  setLiveVoiceScreenShare,
  useLiveVoiceStore,
} from "@/domains/chat/voice/live-voice/live-voice-store";

/**
 * How long a parked share outlives the press that made it.
 *
 * The start request's own bound. The two are halves of one gesture, so a
 * share that could still be applied to a call that could no longer start
 * would be a share waiting on nothing.
 */
export const PENDING_SCREEN_SHARE_TTL_MS = VOICE_START_REQUEST_TTL_MS;

interface PendingScreenShare {
  target: WatchCaptureTarget | null;
  /** When the gesture was made, for the bound above. */
  askedAt: number;
}

let pending: PendingScreenShare | null = null;
let unsubscribe: (() => void) | null = null;

const forget = (): void => {
  pending = null;
  unsubscribe?.();
  unsubscribe = null;
};

const expired = (state: PendingScreenShare): boolean =>
  Date.now() - state.askedAt > PENDING_SCREEN_SHARE_TTL_MS;

/**
 * Apply a parked target the moment a session can be shown it.
 *
 * A store subscriber rather than an effect in the layout that owns sessions:
 * this runs inside the write that starts the session, so the share is on
 * before anything downstream has rendered a call without one.
 */
const watchForTheSession = (): void => {
  if (unsubscribe !== null) {
    return;
  }
  unsubscribe = useLiveVoiceStore.subscribe((state) => {
    if (pending === null) {
      return;
    }
    if (!isLiveVoiceSessionActive(state.state)) {
      return;
    }
    const { target } = pending;
    const stale = expired(pending);
    forget();
    if (target !== null && !stale) {
      setLiveVoiceScreenShare(target);
    }
  });
};

/**
 * Say that a share is on its way and a call is being started to carry it.
 *
 * Armed before the pick is sent rather than after, since main answers a pick
 * it can resolve without waiting for anything: the target can be back before
 * the next line of the caller runs.
 */
export function expectScreenShare(): void {
  pending = { target: null, askedAt: Date.now() };
  watchForTheSession();
}

/**
 * Hold a resolved target until a session arrives, and say whether it was
 * taken.
 *
 * `false` for every target that is not part of a gesture this module is
 * waiting on, which is the ordinary press on the pill: those belong to a
 * session that is already running, and one arriving with no session is a
 * target to drop rather than to keep.
 */
export function parkScreenShare(target: WatchCaptureTarget): boolean {
  if (pending === null || expired(pending)) {
    forget();
    return false;
  }
  if (isLiveVoiceSessionActive(useLiveVoiceStore.getState().state)) {
    forget();
    return false;
  }
  pending = { target, askedAt: pending.askedAt };
  return true;
}

/**
 * Drop whatever is waiting.
 *
 * What the end of a dial means for the share riding on it: the user closed
 * the pill on a call that had not connected, and the screen they asked to
 * show it goes with the call they asked it of.
 */
export function forgetPendingScreenShare(): void {
  forget();
}

/** Whether a share is waiting for a call. For the tests and for callers that
 * need to know a gesture is already in flight. */
export function hasPendingScreenShare(): boolean {
  return pending !== null && !expired(pending);
}

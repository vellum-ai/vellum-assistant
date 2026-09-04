import { create } from "zustand";

import {
  COMPANION_DICTATION_OFFER_MAX,
  type FnClaimant,
} from "@vellumai/ipc-contract";

import {
  setInputActivityWatch,
  subscribeToInputActivity,
} from "@/runtime/input-activity";

/**
 * Vellum's version of a dictation another app has already pasted, while the
 * companion offers it.
 *
 * A hold of the voice key with another dictation app running dictates twice,
 * since nothing on macOS owns a key. Rather than paste beside that app's
 * words, the hold's transcript is parked here and the companion asks what to
 * do with it. The offer is this window's, the way a watch retrospective is:
 * the companion draws it and answers it, and the answer comes back here as a
 * command, because this is the side holding the words and the way into the
 * application they would go to.
 */
export interface DictationOffer {
  app: FnClaimant;
  /**
   * Vellum's words, bounded at {@link COMPANION_DICTATION_OFFER_MAX}. The
   * same value the companion shows and "use" inserts, so what is read is what
   * lands.
   */
  text: string;
  /**
   * The application in front as the hold began, which is where the other app
   * pasted. "Use" acts only while that application is still in front: an
   * undo sent anywhere else would take back someone else's edit.
   */
  frontApp: string | null;
  /** Clears the offer when it goes unanswered. */
  expiry: ReturnType<typeof setTimeout>;
}

/**
 * How long an unanswered offer stands. Long enough to read and decide, short
 * enough that a pill nobody answered does not sit on the desktop all
 * afternoon; a new hold replaces it sooner, and any typing or clicking takes
 * it down.
 */
export const DICTATION_OFFER_TTL_MS = 60_000;

interface DictationOfferState {
  offer: DictationOffer | null;
}

export const useDictationOfferStore = create<DictationOfferState>()(() => ({
  offer: null,
}));

/**
 * The watch that decides whether an offer may still replace an edit.
 *
 * "Use" undoes the last edit in the application the hold was made in, on the
 * understanding that the edit is the other app's paste. Anything the user
 * types or clicks after that paste breaks the understanding: a key is an edit
 * of their own, and a click moves the cursor the replacement would land at.
 *
 * Armed when the hold ends rather than when the offer appears, because the
 * cleanup pass sits between the two and takes seconds. A press in that gap
 * would otherwise go unseen and the offer would be made anyway.
 */
let watching = false;
let sawInput = false;
let unwatch: (() => void) | null = null;

export function armDictationOfferWatch(): void {
  sawInput = false;
  if (watching) {
    return;
  }
  watching = true;
  unwatch = subscribeToInputActivity(() => {
    sawInput = true;
    clearDictationOffer();
  });
  void setInputActivityWatch(true);
}

export function disarmDictationOfferWatch(): void {
  if (!watching) {
    return;
  }
  watching = false;
  unwatch?.();
  unwatch = null;
  void setInputActivityWatch(false);
}

/** Whether the user has typed or clicked since the watch was armed. */
export function sawInputSinceArming(): boolean {
  return sawInput;
}

/**
 * Offer Vellum's words, unless the user has already moved on: a press since
 * the hold ended means the other app's paste is no longer the last edit, so
 * there is nothing "use" could safely replace. Returns whether the offer was
 * made.
 */
export function setDictationOffer(
  app: FnClaimant,
  text: string,
  frontApp: string | null,
): boolean {
  if (sawInput) {
    disarmDictationOfferWatch();
    return false;
  }
  clearDictationOffer({ keepWatch: true });
  const expiry = setTimeout(
    () => clearDictationOffer(),
    DICTATION_OFFER_TTL_MS,
  );
  useDictationOfferStore.setState({
    offer: {
      app,
      text: text.slice(0, COMPANION_DICTATION_OFFER_MAX),
      frontApp,
      expiry,
    },
  });
  return true;
}

/** Take the offer down, and return what it held. */
export function clearDictationOffer({
  keepWatch = false,
}: { keepWatch?: boolean } = {}): DictationOffer | null {
  if (!keepWatch) {
    disarmDictationOfferWatch();
  }
  const { offer } = useDictationOfferStore.getState();
  if (offer === null) {
    return null;
  }
  clearTimeout(offer.expiry);
  useDictationOfferStore.setState({ offer: null });
  return offer;
}

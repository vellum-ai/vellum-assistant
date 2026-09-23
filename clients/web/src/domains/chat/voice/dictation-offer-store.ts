import { create } from "zustand";

import {
  COMPANION_DICTATION_OFFER_MAX,
  type FnClaimant,
  type UnplacedDictationOffer,
} from "@vellumai/ipc-contract";

import { forwardUnplacedDictationOffer } from "@/runtime/companion-surface";
import { isPopoutWindowLifetime } from "@/runtime/popout-window";
import {
  setInputActivityWatch,
  subscribeToInputActivity,
} from "@/runtime/input-activity";

/**
 * A hold's words, parked here while the companion offers them.
 *
 * Three things end a hold with its words still in hand, and all park them
 * here. Another dictation app heard the key too and has already pasted its
 * version, since nothing on macOS owns a key; nothing in the application in
 * front takes text, so no paste was sent at all; or the paste was sent and
 * did not go through. The main window owns the offer and publishes it to
 * the companion. Pop-outs forward unplaced words to that window, where
 * answers and expiry clear the same store that publishes the offer.
 */
interface OfferedWords {
  /**
   * Which offer this is. Minted here, published with the words, and carried
   * back on the answer, so a press made against an offer this store has
   * already replaced is dropped rather than applied to the words that took
   * its place. See {@link CompanionDictationOffer.id}.
   */
  id: string;
  /**
   * The hold's words, bounded at {@link COMPANION_DICTATION_OFFER_MAX}. The
   * same value the companion shows and every answer acts on, so what is read
   * is what lands.
   */
  text: string;
  /** Clears the offer when it goes unanswered. */
  expiry: ReturnType<typeof setTimeout>;
}

export type DictationOffer =
  | (OfferedWords & {
      reason: "claimed";
      app: FnClaimant;
      /**
       * The application in front as the hold began, which is where the other
       * app pasted. "Use" acts only while that application is still in
       * front: an undo sent anywhere else would take back someone else's
       * edit.
       */
      frontApp: string | null;
    })
  | (OfferedWords & { reason: UnplacedReason });

/**
 * Why words that were never pasted are being offered: nothing in front took
 * text, or the paste into something that did failed.
 */
export type UnplacedReason = UnplacedDictationOffer["reason"];

/**
 * How long an unanswered offer stands. Long enough to read and decide, short
 * enough that a pill nobody answered does not sit on the desktop all
 * afternoon; a new hold replaces it sooner, and where the offer is one that
 * would replace another app's paste, any typing or clicking takes it down.
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
  putOffer({ reason: "claimed", app, frontApp }, text);
  return true;
}

/**
 * Offer words that never reached the cursor, because nothing in front would
 * take them or because the paste failed. Unconditional, where the offer above
 * is not: there is no edit of another app's for this one to replace, so
 * nothing the user has typed since can make copying the words the wrong
 * thing. Nothing is watched for the same reason.
 */
export function setUnplacedDictationOffer(
  text: string,
  reason: UnplacedReason = "no-text-field",
): void {
  clearDictationOffer();
  putOffer({ reason }, text);
}

/**
 * Park the words with the timer that takes them back down. The trim is here
 * rather than at either caller so the one bound the companion, the schema and
 * the insert all agree on is applied once.
 */
function putOffer(
  reason:
    | { reason: "claimed"; app: FnClaimant; frontApp: string | null }
    | { reason: UnplacedReason },
  text: string,
): void {
  const boundedText = text.slice(0, COMPANION_DICTATION_OFFER_MAX);
  if (
    reason.reason !== "claimed" &&
    isPopoutWindowLifetime() &&
    forwardUnplacedDictationOffer({ reason: reason.reason, text: boundedText })
  ) {
    return;
  }
  const expiry = setTimeout(
    () => clearDictationOffer(),
    DICTATION_OFFER_TTL_MS,
  );
  useDictationOfferStore.setState({
    offer: {
      ...reason,
      id: crypto.randomUUID(),
      text: boundedText,
      expiry,
    },
  });
}

/** Take the offer down, and return what it held. */
export function clearDictationOffer({
  keepWatch = false,
}: { keepWatch?: boolean } = {}): DictationOffer | null {
  if (!keepWatch) {
    disarmDictationOfferWatch();
    if (isPopoutWindowLifetime()) {
      forwardUnplacedDictationOffer(null);
    }
  }
  const { offer } = useDictationOfferStore.getState();
  if (offer === null) {
    return null;
  }
  clearTimeout(offer.expiry);
  useDictationOfferStore.setState({ offer: null });
  return offer;
}

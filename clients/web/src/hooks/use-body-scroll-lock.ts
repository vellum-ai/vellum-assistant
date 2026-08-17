/**
 * The document body's scroll state while an overlay is open, owned once.
 *
 * Every overlay wants the same thing, that the page behind it must not
 * scroll, and the naive way to get it is three lines an overlay can write for
 * itself: save `document.body.style.overflow`, set `hidden`, restore the
 * saved value on unmount. That works for one overlay and breaks for two,
 * because the saved value is not a fact about the overlay, it is a fact about
 * the page, and two overlays each holding a private copy of it disagree.
 *
 * Concretely, with two independent savers: the second overlay to open records
 * `hidden` (the first one's doing) as the value to restore, so whichever
 * closes first hands scrolling back to a page still covered by the other, and
 * whichever closes last writes `hidden` back onto a page with nothing over
 * it. The body stays unscrollable until reload, and nothing about the overlay
 * that left it that way points at the overlay that did.
 *
 * So the count is the state, not the style: the first lock records what the
 * page looked like unlocked and hides overflow, further locks only add to the
 * count, and the last release restores the one recorded value. Overlays can
 * then overlap in any order, and an overlay opened from inside another (the
 * tray's Share Feedback command lands over whatever the current page has
 * open) is no longer a special case anyone has to have thought about.
 *
 * Radix-based surfaces (`Modal`, `BottomSheet`, `Popover`) get this from
 * `react-remove-scroll` and must not call this hook; it is for the overlays
 * this app renders itself.
 */

import { useEffect } from "react";

let lockCount = 0;
/** The body's own `overflow`, as it was before the first active lock. */
let unlockedOverflow = "";

function acquireBodyScrollLock(): () => void {
  if (lockCount === 0) {
    unlockedOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  lockCount += 1;

  return () => {
    lockCount -= 1;
    if (lockCount === 0) {
      document.body.style.overflow = unlockedOverflow;
    }
  };
}

/**
 * Hold the body scroll lock for as long as this component wants it.
 *
 * Pass `enabled` for an overlay that stays mounted while closed; an overlay
 * that unmounts when it closes can take the default.
 */
export function useBodyScrollLock(enabled = true): void {
  useEffect(() => {
    if (!enabled) {
      return;
    }
    return acquireBodyScrollLock();
  }, [enabled]);
}

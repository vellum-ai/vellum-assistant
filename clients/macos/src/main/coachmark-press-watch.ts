/**
 * The moment the user presses the control the assistant is pointing at.
 *
 * A mark says go and press that, and the press is the step being done. The
 * watch frame the marks are drawn on is click-through while they stand, so
 * the press goes to the app underneath and the frame never sees it. The
 * desktop does, and the mac helper reads it: this module is where the two
 * meet, the way `frame-scroll-watch.ts` is for a scroll.
 *
 * A module of its own for the reason that one is: the companion window owns
 * the marks, the helper bridge owns the input stream, and neither imports
 * the other. The window says what is being pointed at and what to do when
 * one of them is pressed; the bridge says how to ask the helper, and reports
 * the press when the helper does.
 *
 * One press per set of marks. The helper takes its monitor down on the first
 * hit and the waiter here is forgotten with it, so a second press on the same
 * control cannot report the step done twice. Pointing again arms it again.
 */

/** Where a pointed-at control is, in screen points with a top-left origin. */
export interface CoachmarkPressRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type SendPressWatch = (rects: readonly CoachmarkPressRect[]) => void;

interface Waiter {
  rects: readonly CoachmarkPressRect[];
  onPressed: (index: number) => void;
}

let send: SendPressWatch | null = null;
let waiter: Waiter | null = null;

/**
 * Start waiting for a press inside any of `rects`. `listener` is told which
 * one, as an index into the list given. One waiter at a time: a later call
 * replaces the earlier one's rectangles and listener both.
 */
export const watchCoachmarkPress = (
  rects: readonly CoachmarkPressRect[],
  listener: (index: number) => void,
): void => {
  if (rects.length === 0) {
    unwatchCoachmarkPress();
    return;
  }
  waiter = { rects, onPressed: listener };
  send?.(rects);
};

/** Stop waiting, and take the helper's watch down with it. */
export const unwatchCoachmarkPress = (): void => {
  if (waiter === null) {
    return;
  }
  waiter = null;
  send?.([]);
};

/**
 * The rectangles being waited on, or nothing, so a helper that restarts is
 * put back to watching the same ones.
 */
export const watchedCoachmarkPress = (): readonly CoachmarkPressRect[] | null =>
  waiter?.rects ?? null;

/**
 * Register the way to ask the helper. A waiter that arrived first gets its
 * watch sent now.
 */
export const provideCoachmarkPressWatch = (next: SendPressWatch): void => {
  send = next;
  if (waiter !== null) {
    next(waiter.rects);
  }
};

/**
 * The helper saw a press land in the rectangle at `index`.
 *
 * The waiter is forgotten before it is told, since what it does on a press
 * is likely to point at something else, which arms a new one. A report
 * naming a rectangle the waiter does not have is a report about a watch
 * that has since been replaced, and is dropped.
 */
export const coachmarkPressed = (index: number): void => {
  const current = waiter;
  if (current === null || index < 0 || index >= current.rects.length) {
    return;
  }
  waiter = null;
  current.onPressed(index);
};

export const __resetCoachmarkPressWatchForTesting = (): void => {
  send = null;
  waiter = null;
};

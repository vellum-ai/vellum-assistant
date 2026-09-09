/**
 * The moment a scroll on the desktop stops, for the watch frame that stepped
 * aside for it.
 *
 * The frame goes click-through for a scroll so the shared app can take it,
 * and in that state it is told about mouse-move and nothing else: a press
 * that follows the scroll without a move lands on the app. The desktop has
 * the signal the frame is missing, and the mac helper reads it: this module
 * is where the two meet.
 *
 * A module of its own for the reason `companion-pointer.ts` is: the companion
 * window owns the frame, the helper bridge owns the input stream, and neither
 * imports the other. The window says whether it is waiting and what to do
 * when the scroll ends; the bridge says how to ask the helper, and reports
 * the end when the helper does.
 */

type SendScrollWatch = (enable: boolean) => void;

let send: SendScrollWatch | null = null;
let onEnded: (() => void) | null = null;

/**
 * Start waiting for the current scroll to end. One waiter at a time: a
 * second call replaces the first's listener, and asks the helper again
 * only if nothing was being watched.
 */
export const watchFrameScroll = (listener: () => void): void => {
  const wasWatching = onEnded !== null;
  onEnded = listener;
  if (!wasWatching) {
    send?.(true);
  }
};

/** Stop waiting, and take the helper's watch down with it. */
export const unwatchFrameScroll = (): void => {
  if (onEnded === null) {
    return;
  }
  onEnded = null;
  send?.(false);
};

/** Whether a waiter is up, so a helper that restarts is put back to watching. */
export const isFrameScrollWatched = (): boolean => onEnded !== null;

/**
 * Register the way to ask the helper. A waiter that arrived first gets its
 * watch sent now.
 */
export const provideFrameScrollWatch = (next: SendScrollWatch): void => {
  send = next;
  if (onEnded !== null) {
    next(true);
  }
};

/** The helper saw the scroll stop. */
export const frameScrollEnded = (): void => {
  onEnded?.();
};

export const __resetFrameScrollWatchForTesting = (): void => {
  send = null;
  onEnded = null;
};

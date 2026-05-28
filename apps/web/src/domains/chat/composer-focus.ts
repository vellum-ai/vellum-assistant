/**
 * Coordinates focus requests for the chat composer textarea across route
 * boundaries. The textarea ref lives in `chat-page.tsx`; callers in
 * higher-level layouts (and the Electron command bus) request focus via
 * `requestComposerFocus()`, which:
 *
 * - fires a window event consumed by `chat-page`'s mounted listener
 *   (for the same-route case), AND
 * - sets a one-shot pending flag that `chat-page` drains on its next
 *   mount (for the case where the caller navigated to the conversation
 *   route from elsewhere — `/assistant/home`, `/assistant/library`,
 *   etc. — and the listener doesn't exist yet at dispatch time).
 *
 * Without the pending-flag drain, File > Current Conversation would no-op
 * when invoked from non-chat routes.
 */
export const COMPOSER_FOCUS_EVENT = "vellum:focus-composer";

let pending = false;

export function requestComposerFocus(): void {
  pending = true;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(COMPOSER_FOCUS_EVENT));
  }
}

/** Returns and clears the pending flag in one step. */
export function consumePendingComposerFocus(): boolean {
  const wasPending = pending;
  pending = false;
  return wasPending;
}

/**
 * Coordinates focus requests for the chat composer textarea across route
 * boundaries. The textarea ref lives in `chat-page.tsx`; callers in
 * higher-level layouts (and the Electron command bus) request focus via
 * `requestComposerFocus()`, which:
 *
 * - fires a window event consumed by `chat-page`'s mounted listener
 *   (for the same-route case), AND
 * - sets a pending flag that `chat-page` drains on its next mount (for
 *   the case where the caller navigated to the conversation route from
 *   elsewhere: `/assistant/home`, `/assistant/library`, etc., and the
 *   listener doesn't exist yet at dispatch time).
 *
 * Starting a new chat also remounts empty-state chrome around the
 * composer (starters docking, greeting paint). A single `.focus()` on
 * the pre-remount node lands, then the node is replaced and focus falls
 * back to `<body>`. `tryClaimComposerFocus` keeps reclaiming the live
 * textarea for {@link COMPOSER_FOCUS_CLAIM_MS} so the caret survives
 * that layout churn, and stops if the user moves to another field or a
 * modal in the meantime.
 *
 * Without the pending-flag drain, File > Current Conversation would no-op
 * when invoked from non-chat routes.
 */
export const COMPOSER_FOCUS_EVENT = "vellum:focus-composer";

/**
 * How long a composer-focus request keeps reclaiming the textarea after
 * layout churn. Long enough for the new-chat empty-state tree to settle,
 * short enough that a later click elsewhere is not stolen.
 */
export const COMPOSER_FOCUS_CLAIM_MS = 800;

let pending = false;
let pendingUntil = 0;
let claimed = false;

export function requestComposerFocus(): void {
  pending = true;
  claimed = false;
  pendingUntil = Date.now() + COMPOSER_FOCUS_CLAIM_MS;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(COMPOSER_FOCUS_EVENT));
  }
}

/** Returns and clears the pending flag in one step. */
export function consumePendingComposerFocus(): boolean {
  const wasPending = pending;
  pending = false;
  claimed = false;
  pendingUntil = 0;
  return wasPending;
}

/** True while a focus request is still allowed to claim the textarea. */
export function isComposerFocusPending(): boolean {
  if (!pending) {
    return false;
  }
  if (Date.now() >= pendingUntil) {
    pending = false;
    claimed = false;
    return false;
  }
  return true;
}

/**
 * Focus `element` if a composer-focus request is still live. Reclaims from
 * `<body>` after a remount; yields if the user has moved to another text
 * field, a modal, or (after the first successful claim) any other control.
 */
export function tryClaimComposerFocus(
  element: HTMLTextAreaElement | null,
): void {
  if (!element || !isComposerFocusPending()) {
    return;
  }
  if (element.disabled || element.readOnly) {
    return;
  }
  if (
    typeof document !== "undefined" &&
    document.querySelector('[aria-modal="true"]')
  ) {
    consumePendingComposerFocus();
    return;
  }
  const active =
    typeof document === "undefined" ? null : document.activeElement;
  if (active === element) {
    claimed = true;
    return;
  }
  if (isTextEntryElement(active) && active !== element) {
    consumePendingComposerFocus();
    return;
  }
  if (claimed) {
    if (
      active &&
      active !== document.body &&
      active !== document.documentElement
    ) {
      consumePendingComposerFocus();
      return;
    }
  }
  element.focus({ preventScroll: true });
  if (typeof document !== "undefined" && document.activeElement === element) {
    claimed = true;
  }
}

type ComposerTypingKeyEvent = Pick<
  KeyboardEvent,
  | "altKey"
  | "ctrlKey"
  | "defaultPrevented"
  | "isComposing"
  | "key"
  | "keyCode"
  | "metaKey"
>;

const TEXT_ENTRY_SELECTOR = [
  "input",
  "textarea",
  "select",
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[role="textbox"]',
].join(",");

function isTextEntryElement(element: Element | null): boolean {
  return Boolean(element?.closest(TEXT_ENTRY_SELECTOR));
}

function isKeyboardActivationElement(element: Element | null): boolean {
  return Boolean(element?.closest("a[href], button, summary"));
}

export function shouldFocusComposerForTyping(
  event: ComposerTypingKeyEvent,
  activeElement: Element | null,
): boolean {
  if (event.defaultPrevented) {
    return false;
  }
  if (event.metaKey || event.ctrlKey || event.altKey) {
    return false;
  }
  if (event.isComposing || event.keyCode === 229) {
    return false;
  }
  // `event.key` is typed as `string` but synthetic / extension-dispatched
  // KeyboardEvents observed in production have arrived with no `key`
  // property at all. Guard before reading `.length`.
  if (typeof event.key !== "string" || event.key.length !== 1) {
    return false;
  }
  if (isTextEntryElement(activeElement)) {
    return false;
  }
  if (event.key === " " && isKeyboardActivationElement(activeElement)) {
    return false;
  }
  return true;
}

export function insertTextAtSelection({
  value,
  text,
  selectionStart,
  selectionEnd,
}: {
  value: string;
  text: string;
  selectionStart: number | null | undefined;
  selectionEnd: number | null | undefined;
}): { value: string; cursor: number } {
  const start = Math.max(
    0,
    Math.min(selectionStart ?? value.length, value.length),
  );
  const end = Math.max(start, Math.min(selectionEnd ?? start, value.length));
  const nextValue = value.slice(0, start) + text + value.slice(end);
  return { value: nextValue, cursor: start + text.length };
}

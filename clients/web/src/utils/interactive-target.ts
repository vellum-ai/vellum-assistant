/**
 * Single source of truth for what counts as an "interactive" element for
 * touch/click gesture guards — inline links, buttons, form controls, and other
 * `[role="button"]` controls. A touch or click that lands on one of these is
 * the user interacting with that control, not a message-level gesture
 * (long-press action sheet, bubble tap).
 *
 * Both the long-press touchstart guard (`use-long-press`) and the bubble-click
 * guard (`isInteractiveClickTarget`, used by transcript-message-body) key off
 * this selector, so they must agree on what is interactive — hence one shared
 * definition rather than a copy in each. See AGENTS.md → Single Source of Truth.
 */
export const INTERACTIVE_TARGET_SELECTOR =
  'a, button, [role="button"], input, textarea, select';

/**
 * Whether `target` is, or is nested inside, an interactive element (see
 * {@link INTERACTIVE_TARGET_SELECTOR}).
 */
export function isInteractiveTarget(target: Element | null): boolean {
  return Boolean(target?.closest(INTERACTIVE_TARGET_SELECTOR));
}

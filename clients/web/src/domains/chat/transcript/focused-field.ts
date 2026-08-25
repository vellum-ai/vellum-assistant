import { CARET_SURFACE_SELECTOR } from "@/utils/caret-surface";

/**
 * Scroll the text field inside `container` that holds focus just far enough to
 * stay visible, reporting whether there was one.
 *
 * Transcript rows can carry a text field of their own (the inline "Connect
 * Claude Code" paste field, the question-prompt card). Those scroll with the
 * thread rather than sitting in fixed chrome the way the composer does, so a
 * pin to the latest message scrolls straight past a field the user is typing
 * in. On a phone the soft keyboard opening is itself the resize that triggers
 * that pin, which makes tapping such a field the thing that hides it.
 *
 * `nearest` so a field that is already on screen does not move at all.
 */
export function keepFocusedFieldVisible(
  container: HTMLElement | null,
): boolean {
  const active = document.activeElement;
  if (
    !container ||
    !(active instanceof HTMLElement) ||
    !container.contains(active) ||
    !active.matches(CARET_SURFACE_SELECTOR)
  ) {
    return false;
  }
  active.scrollIntoView({ block: "nearest", behavior: "auto" });
  return true;
}

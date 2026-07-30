import type { KeyboardEvent } from "react";

const NEXT_KEYS = new Set(["ArrowDown", "ArrowRight"]);
const PREV_KEYS = new Set(["ArrowUp", "ArrowLeft"]);

/**
 * Arrow-key navigation for a `role="radiogroup"` container of rich card
 * radios, reproducing native radio-group semantics: arrows move focus and
 * selection to the adjacent enabled radio, wrapping at the ends. Pairs with
 * a roving tab stop on the cards (`tabIndex` 0 on the checked card, -1
 * elsewhere). The design-library `RadioGroup`/`Radio` primitives own these
 * semantics for standard dot-and-label radios, but their fixed layout cannot
 * wrap these card surfaces, so the chooser cards reproduce them instead.
 *
 * Selection is applied by clicking the target card, so each card's own
 * select handler stays the single source of truth.
 */
export function handleRadioCardArrowNav(e: KeyboardEvent<HTMLElement>): void {
  if (!NEXT_KEYS.has(e.key) && !PREV_KEYS.has(e.key)) {
    return;
  }
  const radios = Array.from(
    e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]'),
  );
  if (radios.length === 0) {
    return;
  }
  const forward = NEXT_KEYS.has(e.key);
  const focused = radios.indexOf(document.activeElement as HTMLElement);
  const current =
    focused >= 0
      ? focused
      : radios.findIndex((r) => r.getAttribute("aria-checked") === "true");
  const next =
    current < 0
      ? radios[forward ? 0 : radios.length - 1]
      : radios[(current + (forward ? 1 : -1) + radios.length) % radios.length];
  e.preventDefault();
  next.focus();
  next.click();
}

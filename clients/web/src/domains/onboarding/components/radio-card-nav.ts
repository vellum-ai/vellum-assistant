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
 * Only events originating on one of the group's radios are handled; arrows
 * pressed on other controls inside the group (a create row, a card's inline
 * buttons) keep their default behavior and never move the selection.
 * Selection is applied by clicking the target card, so each card's own
 * select handler stays the single source of truth.
 */
export function handleRadioCardArrowNav(e: KeyboardEvent<HTMLElement>): void {
  if (!NEXT_KEYS.has(e.key) && !PREV_KEYS.has(e.key)) {
    return;
  }
  const origin = (e.target as HTMLElement).closest<HTMLElement>(
    '[role="radio"]',
  );
  if (!origin) {
    return;
  }
  const radios = Array.from(
    e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]'),
  );
  const current = radios.indexOf(origin);
  if (current < 0) {
    return;
  }
  const delta = NEXT_KEYS.has(e.key) ? 1 : -1;
  const next = radios[(current + delta + radios.length) % radios.length];
  e.preventDefault();
  next.focus();
  next.click();
}

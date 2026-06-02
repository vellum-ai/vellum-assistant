/** Pure helper functions for text-triggered popup logic.
 *
 *  Separated from the React hook (`useTextPopup`) so they can be
 *  unit-tested without a component render cycle. */

/** Wrapping index when navigating up in a list. */
export function listIndexUp(current: number, listLength: number): number {
  if (listLength === 0) return 0;
  return current <= 0 ? listLength - 1 : current - 1;
}

/** Wrapping index when navigating down in a list. */
export function listIndexDown(current: number, listLength: number): number {
  if (listLength === 0) return 0;
  return current >= listLength - 1 ? 0 : current + 1;
}

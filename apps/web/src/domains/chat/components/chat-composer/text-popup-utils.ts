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

/**
 * Pure derivation of text-triggered popup visibility. Given the input text,
 * a trigger regex (must have one capture group for the filter), a search
 * function, and a suppress flag, returns whether the popup should show, the
 * extracted filter string, and matched items.
 */
export function derivePopupState<T>(
  text: string,
  trigger: RegExp,
  search: (filter: string) => T[],
  suppressed: boolean,
  minFilterLength = 0,
): { show: boolean; filter: string; items: T[] } {
  const EMPTY_ARRAY: never[] = [];
  const match = trigger.exec(text);
  if (!match) return { show: false, filter: "", items: EMPTY_ARRAY as unknown as T[] };
  const filter = match[1] ?? "";
  if (filter.length < minFilterLength) return { show: false, filter, items: EMPTY_ARRAY as unknown as T[] };
  const items = search(filter);
  return { show: items.length > 0 && !suppressed, filter, items };
}

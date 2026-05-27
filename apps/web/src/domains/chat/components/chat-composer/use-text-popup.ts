import { useCallback, useMemo, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

const EMPTY_ARRAY: never[] = [];

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
  const match = trigger.exec(text);
  if (!match) return { show: false, filter: "", items: EMPTY_ARRAY as unknown as T[] };
  const filter = match[1] ?? "";
  if (filter.length < minFilterLength) return { show: false, filter, items: EMPTY_ARRAY as unknown as T[] };
  const items = search(filter);
  return { show: items.length > 0 && !suppressed, filter, items };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface TextPopupConfig<T> {
  text: string;
  trigger: RegExp;
  search: (filter: string) => T[];
  minFilterLength?: number;
}

export interface TextPopup<T> {
  show: boolean;
  filter: string;
  items: T[];
  selectedIndex: number;
  moveUp: () => void;
  moveDown: () => void;
  dismiss: () => void;
}

/**
 * Generic hook for text-triggered popups with keyboard navigation.
 *
 * Popup visibility and items are *derived* from the input text — no internal
 * state is stored for these. Only the keyboard selection index and the
 * suppress-after-dismiss flag are stateful. This eliminates the class of
 * infinite re-render bugs caused by always-new object references in setState.
 *
 * @see https://react.dev/reference/react/useState#storing-information-from-previous-renders
 */
export function useTextPopup<T>(config: TextPopupConfig<T>): TextPopup<T> {
  const { text, trigger, search, minFilterLength = 0 } = config;

  // Suppress: after dismiss, prevent the popup from showing until the text
  // changes from what it was at the time of dismiss.
  const suppressRef = useRef(false);
  const textAtSuppressRef = useRef<string | null>(null);

  if (
    suppressRef.current &&
    textAtSuppressRef.current !== null &&
    text !== textAtSuppressRef.current
  ) {
    suppressRef.current = false;
    textAtSuppressRef.current = null;
  }

  const match = trigger.exec(text);
  const hasMatch = match !== null;
  const filter = match?.[1] ?? "";
  const meetsMinLength = filter.length >= minFilterLength;

  const items = useMemo(() => {
    if (!hasMatch || !meetsMinLength) return EMPTY_ARRAY as unknown as T[];
    return search(filter);
  }, [hasMatch, meetsMinLength, filter, search]);

  const show = items.length > 0 && !suppressRef.current;

  // Reset selection index when the filter string changes.
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [prevFilter, setPrevFilter] = useState(filter);
  if (prevFilter !== filter) {
    setPrevFilter(filter);
    setSelectedIndex(0);
  }

  const itemCount = items.length;
  const moveUp = useCallback(() => {
    setSelectedIndex((prev) => listIndexUp(prev, itemCount));
  }, [itemCount]);

  const moveDown = useCallback(() => {
    setSelectedIndex((prev) => listIndexDown(prev, itemCount));
  }, [itemCount]);

  // Stable ref so dismiss always captures the text at invocation time.
  const textRef = useRef(text);
  textRef.current = text;

  const [, forceRender] = useState(0);
  const dismiss = useCallback(() => {
    suppressRef.current = true;
    textAtSuppressRef.current = textRef.current;
    forceRender((n) => n + 1);
  }, []);

  return { show, filter, items, selectedIndex, moveUp, moveDown, dismiss };
}

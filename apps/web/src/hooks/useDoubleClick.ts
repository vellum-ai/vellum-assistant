import { useCallback, useEffect, useRef } from "react";

export interface UseDoubleClickOptions {
  /** Milliseconds to wait before confirming a single click. Default: 200.
   * Only matters as a fallback — `event.detail` already uses the OS-native
   * double-click threshold to count clicks. */
  latency?: number;
}

/**
 * Hook for disambiguating single and double clicks on the same element.
 *
 * Returns a click handler that defers `onSingleClick` until it confirms the
 * click isn't the start of a double-click sequence. Uses `event.detail`
 * (the browser's native click counter, which respects OS double-click timing)
 * rather than maintaining a custom click counter.
 *
 * Callbacks receive no event argument because `onSingleClick` is deferred
 * via setTimeout — by then React has recycled the synthetic event and
 * `currentTarget` is null. Callers that need event data should capture it
 * synchronously in the outer onClick handler.
 *
 * @see https://github.com/w3c/pointerevents/issues/582
 * @see https://github.com/zattoo/use-double-click (same pattern)
 *
 * @example
 * ```tsx
 * const handleClick = useDoubleClick({
 *   onSingleClick: () => selectItem(id),
 *   onDoubleClick: () => openItem(id),
 * });
 * return <div onClick={handleClick}>...</div>;
 * ```
 */
export function useDoubleClick({
  onSingleClick,
  onDoubleClick,
  latency = 200,
}: {
  onSingleClick?: () => void;
  onDoubleClick?: () => void;
} & UseDoubleClickOptions): (event: React.MouseEvent) => void {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return useCallback(
    (event: React.MouseEvent) => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }

      if (onSingleClick && event.detail === 1) {
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          onSingleClick();
        }, latency);
      }

      if (onDoubleClick && event.detail >= 2 && event.detail % 2 === 0) {
        onDoubleClick();
      }
    },
    [onSingleClick, onDoubleClick, latency],
  );
}

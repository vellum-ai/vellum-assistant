import { useCallback, useSyncExternalStore } from "react";

/**
 * Subscribes to a CSS media query and re-renders when it starts or stops
 * matching. SSR reports `false`, so server-rendered markup matches the
 * query-not-matching path.
 *
 * Prefer a plain Tailwind variant when CSS can express the difference, and a
 * named hook (`useIsMobile`, `useTouchMobile`) when the query is a shared
 * breakpoint rather than one component's own. See `docs/PLATFORM_ADAPTATION.md`
 * for which signal a given difference belongs to.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    [query],
  );
  const getSnapshot = useCallback(
    () => window.matchMedia(query).matches,
    [query],
  );

  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

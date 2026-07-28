import { useSyncExternalStore } from "react";

/**
 * Media query that marks viewports narrow enough to swap a sidebar rail
 * for an overlay drawer. Mirrors `SidebarPageLayout`'s `md:` breakpoint
 * (768px).
 */
export const MOBILE_MEDIA_QUERY = "(max-width: 767px)";

function subscribe(onChange: () => void): () => void {
  const mql = window.matchMedia(MOBILE_MEDIA_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function getSnapshot(): boolean {
  return window.matchMedia(MOBILE_MEDIA_QUERY).matches;
}

function getServerSnapshot(): boolean {
  // SSR can't read the viewport — default to desktop (not mobile) so
  // server-rendered markup matches the wide-layout path.
  return false;
}

/**
 * Returns `true` while the viewport matches `MOBILE_MEDIA_QUERY`
 * (`max-width: 767px`).
 */
export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

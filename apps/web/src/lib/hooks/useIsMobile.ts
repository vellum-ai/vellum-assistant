
import { useSyncExternalStore } from "react";

/**
 * Media query that marks viewports narrow enough to swap a sidebar rail for
 * an overlay drawer. Mirrors `SidebarPageLayout`'s `md:` breakpoint (768px).
 *
 * Exported so callers that need to re-read the live match value at event
 * time (e.g. `AssistantShell`'s `toggleSidebar`) can construct the same
 * `MediaQueryList` rather than duplicate the string.
 */
export const MOBILE_MEDIA_QUERY = "(max-width: 767px)";

/**
 * External-store wiring for the mobile media query. Defined at module scope
 * so `useSyncExternalStore` receives stable references across renders (if
 * these were declared inside the hook each render would re-subscribe).
 */
function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }
  const mql = window.matchMedia(MOBILE_MEDIA_QUERY);
  mql.addEventListener("change", onChange);
  return () => {
    mql.removeEventListener("change", onChange);
  };
}

function getSnapshot(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return window.matchMedia(MOBILE_MEDIA_QUERY).matches;
}

function getServerSnapshot(): boolean {
  return false;
}

/**
 * Returns `true` while the viewport matches `MOBILE_MEDIA_QUERY`
 * (`max-width: 767px`). SSR-safe — returns `false` on the server and on
 * the first client render before `useSyncExternalStore` has subscribed.
 *
 * Use this anywhere a component needs to branch on mobile vs. desktop
 * layout. For one-off invocation-time checks (where re-rendering on
 * viewport change is undesired) call `window.matchMedia(MOBILE_MEDIA_QUERY)`
 * directly instead.
 */
export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

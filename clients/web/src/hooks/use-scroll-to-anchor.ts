import { useEffect, useState } from "react";

/**
 * One-shot scroll to an in-page anchor named by the URL hash.
 *
 * Captures `window.location.hash` when the calling component first renders,
 * because later same-route navigations (e.g. tab rewrites via
 * `setSearchParams`) drop the hash from the URL before async content settles.
 * Scrolls once `ready` turns true and the element exists, then never again for
 * the component's lifetime.
 */
export function useScrollToAnchor(anchorId: string, ready: boolean): void {
  const [targetsAnchor] = useState(
    () => window.location.hash === `#${anchorId}`,
  );
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    if (!targetsAnchor || scrolled || !ready) {
      return;
    }
    const element = document.getElementById(anchorId);
    if (!element) {
      return;
    }
    setScrolled(true);
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    element.scrollIntoView({
      behavior: reduceMotion ? "auto" : "smooth",
      block: "start",
    });
  }, [targetsAnchor, scrolled, ready, anchorId]);
}

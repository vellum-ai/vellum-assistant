import { useEffect, useState } from "react";

import { useIsMobile } from "@/hooks/use-is-mobile";

/**
 * Resolves the mobile overlay portal target after DOM commit so chat-side
 * full-screen overlays (`MobileDocumentOverlay`, `MobileSubagentDetailOverlay`,
 * `MobileAppOverlay`) can be portaled into `RootLayout`'s `#viewport-overlays`
 * container, outside the main content wrapper.
 *
 * Why the `useEffect` instead of resolving the element during render:
 * `document.getElementById("viewport-overlays")` is a DOM read that needs
 * the SSR-safe deferred-to-commit pattern documented in
 * `apps/web/docs/CONVENTIONS.md` §SSR. Resolving during render would also
 * miss the element on first paint because `RootLayout` mounts it.
 *
 * Returns `null` on non-mobile viewports — desktop overlays render inline
 * inside the normal layout flow.
 */
export function useMobileOverlayTarget(): HTMLElement | null {
  const isMobile = useIsMobile();
  const [target, setTarget] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setTarget(
      isMobile ? document.getElementById("viewport-overlays") : null,
    );
  }, [isMobile]);

  return target;
}

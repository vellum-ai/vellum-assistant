import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Tap-to-reveal state for a transcript row whose actions are hover-revealed.
 * Hover and focus-visible cannot surface those actions on touch screens, so
 * the row wrapper stamps `data-revealed={revealed}` (styled via
 * `group-data-[revealed=true]/msg:*` classes) and calls `toggleRevealed()`
 * from its coarse-pointer tap handler. While revealed, a document-level
 * pointerdown listener dismisses the reveal on any press outside `wrapperRef`.
 */
export function useCoarsePointerReveal() {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    if (!revealed) {
      return;
    }
    const onDocPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (
        target &&
        wrapperRef.current &&
        !wrapperRef.current.contains(target)
      ) {
        setRevealed(false);
      }
    };
    document.addEventListener("pointerdown", onDocPointerDown);
    return () => document.removeEventListener("pointerdown", onDocPointerDown);
  }, [revealed]);

  const toggleRevealed = useCallback(() => setRevealed((v) => !v), []);

  return { wrapperRef, revealed, toggleRevealed };
}

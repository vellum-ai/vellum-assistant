import { useEffect, useRef, useState, type MouseEvent } from "react";

import {
  CompanionSurface,
  type CompanionSurfacePhase,
} from "@/components/companion-surface";
import {
  getCompanionState,
  setCompanionInteractive,
  subscribeCompanionState,
} from "@/runtime/companion-surface";
import type { CompanionAnchor } from "@vellumai/ipc-contract";

/**
 * The companion surface inside its Electron canvas
 * (`clients/macos/src/main/companion-window.ts`).
 *
 * Standalone (no auth, no RootLayout) like the dictation overlay and Quick
 * Input, so it paints as soon as the window opens. The canvas is transparent
 * and much larger than the pill: the page paints only the pill and leaves the
 * rest of the window empty, which is what lets the expansion be CSS in a window
 * that never resizes.
 *
 * **The page owns interactivity.** The window is click-through so its mostly
 * empty canvas does not swallow presses meant for the desktop behind it, and
 * only the page knows where the pill is actually drawn, so it tells main when
 * the pointer is over the surface and main makes the window clickable for
 * exactly that long.
 */
export function CompanionSurfacePage() {
  const [anchor, setAnchor] = useState<CompanionAnchor>("center");
  const [hovered, setHovered] = useState(false);
  // Mirrors what main was last told, so a pointer crossing the pill does not
  // send the same instruction on every mouse-move.
  const interactiveRef = useRef(false);
  const pillRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const unsubscribe = subscribeCompanionState((state) => {
      setAnchor(state.anchor);
    });
    // The route chunk loads lazily after the window is created, so a state
    // pushed before this subscription registered was dropped. Catch up.
    void getCompanionState().then((initial) => {
      if (initial) {
        setAnchor(initial.anchor);
      }
    });
    return unsubscribe;
  }, []);

  // Never leave the window clickable behind us: an unmount mid-hover would
  // otherwise strand a transparent canvas that eats every click on that corner
  // of the screen.
  useEffect(() => {
    return () => {
      setCompanionInteractive(false);
    };
  }, []);

  const setInteractive = (next: boolean) => {
    if (interactiveRef.current === next) {
      return;
    }
    interactiveRef.current = next;
    setCompanionInteractive(next);
  };

  /**
   * Hit-test the pointer against the pill on every move.
   *
   * Not `mouseenter`: a click-through window delivers forwarded mouse-move and
   * little else, so entering and leaving have to be derived from coordinates.
   * `dictation-overlay-page.tsx` measures its stop button the same way for the
   * same reason. The rect is read live rather than cached because the pill
   * changes width as it expands, and a stale rect would collapse the surface
   * the moment it finished growing.
   */
  const onMouseMove = (event: MouseEvent<HTMLDivElement>) => {
    const pill = pillRef.current;
    if (!pill) {
      return;
    }
    const rect = pill.getBoundingClientRect();
    const inside =
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom;
    setHovered(inside);
    setInteractive(inside);
  };

  const phase: CompanionSurfacePhase = hovered ? "hover" : "resting";

  return (
    <div
      className="relative h-screen w-screen bg-transparent"
      onMouseMove={onMouseMove}
      onMouseLeave={() => {
        // The pointer left the canvas entirely, which mouse-move cannot report.
        setHovered(false);
        setInteractive(false);
      }}
    >
      <CompanionSurface phase={phase} anchor={anchor} rootRef={pillRef} />
    </div>
  );
}

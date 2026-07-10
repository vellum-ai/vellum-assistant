import { lazy, useMemo } from "react";
import {
  AnimatePresence,
  motion,
  useDragControls,
  useReducedMotion,
  type PanInfo,
} from "motion/react";

import { LazyBoundary } from "@/components/lazy-boundary";
import { useMobileOverlayViewportStyle } from "@/hooks/use-mobile-overlay-viewport-style";
import { haptic } from "@/utils/haptics";
import { isPointerCoarse } from "@/utils/pointer";
import type { SubagentEntry } from "@/domains/chat/subagent-store";

const SubagentDetailPanel = lazy(() =>
  import("@/domains/chat/components/subagent-detail-panel").then((m) => ({
    default: m.SubagentDetailPanel,
  })),
);

/** Minimum downward drag (px) to commit the dismiss gesture. */
const DRAG_DISMISS_THRESHOLD_PX = 100;

interface MobileSubagentDetailOverlayProps {
  /** When `null`, the overlay renders nothing. */
  entry: SubagentEntry | null;
  /** Closes the overlay. */
  onClose: () => void;
  /** Stop a running subagent. */
  onStop?: (subagentId: string) => void;
  /** Request detail fetch for a subagent. */
  onRequestDetail?: (subagentId: string) => void;
}

/**
 * Mobile-only full-screen overlay that hosts the subagent detail panel.
 *
 * **Mounting constraint**: must render inside `RootLayout`'s
 * `#viewport-overlays` portal, outside the main content wrapper.
 */
export function MobileSubagentDetailOverlay({
  entry,
  onClose,
  onStop,
  onRequestDetail,
}: MobileSubagentDetailOverlayProps) {
  const reduce = useReducedMotion();
  const shellStyle = useMobileOverlayViewportStyle();
  const isTouch = useMemo(() => isPointerCoarse(), []);
  const dragControls = useDragControls();

  const handleDragEnd = (_event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
    if (info.offset.y > DRAG_DISMISS_THRESHOLD_PX) {
      haptic.light();
      onClose();
    }
  };

  return (
    <AnimatePresence>
      {entry && (
        <motion.div
          key="mobile-detail-overlay"
          className="fixed inset-x-0 z-30 flex flex-col"
          style={shellStyle}
          initial={{ y: "100%", opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: "100%", opacity: 0 }}
          transition={reduce ? { duration: 0 } : { duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
          // Drag-to-dismiss: drag down past the threshold to close. Only
          // enabled on touch devices so desktop mouse interaction is
          // unaffected. The auto drag listener is disabled (`dragListener={
          // false}`) and the gesture is started manually from the grabber bar
          // below via `dragControls.start(e)`, so the scrollable body (which
          // is `overflow-y-auto`) stays free for native scrolling — dragging
          // inside the content scrolls it instead of dismissing the sheet.
          // Constraints at 0 with downward-only elasticity create a
          // rubber-band drag that snaps back on release unless committed.
          drag={isTouch ? "y" : false}
          dragControls={dragControls}
          dragListener={false}
          dragConstraints={{ top: 0, bottom: 0 }}
          dragElastic={{ top: 0, bottom: 0.6 }}
          dragMomentum={false}
          onDragEnd={handleDragEnd}
        >
          {isTouch && (
            // Grabber bar — the sole drag-to-dismiss handle. Pointer down
            // here manually starts the Motion drag so only this bar (not the
            // scrollable body) can dismiss the sheet. `touch-none` lets
            // Motion own the gesture without the browser also panning. The
            // background + top rounding visually merge with the panel below
            // (which has `rounded-xl` + the same `--surface-lift` bg).
            <div
              className="flex shrink-0 cursor-grab touch-none justify-center rounded-t-xl bg-[var(--surface-lift)] py-2 active:cursor-grabbing"
              onPointerDown={(e) => dragControls.start(e)}
            >
              <div className="h-1.5 w-10 rounded-full bg-[var(--border-hover)]" />
            </div>
          )}
          <div className="min-h-0 flex-1">
            <LazyBoundary>
              <SubagentDetailPanel
                entry={entry}
                onClose={onClose}
                onStop={onStop}
                onRequestDetail={onRequestDetail}
              />
            </LazyBoundary>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
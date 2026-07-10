import { lazy, useMemo } from "react";
import { AnimatePresence, motion, useReducedMotion, type PanInfo } from "motion/react";

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
          className="fixed inset-x-0 z-30"
          style={shellStyle}
          initial={{ y: "100%", opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: "100%", opacity: 0 }}
          transition={reduce ? { duration: 0 } : { duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
          // Drag-to-dismiss: drag down past the threshold to close. Only
          // enabled on touch devices so desktop mouse interaction is
          // unaffected. Constraints at 0 with downward-only elasticity create
          // a rubber-band drag that snaps back on release unless committed.
          drag={isTouch ? "y" : false}
          dragConstraints={{ top: 0, bottom: 0 }}
          dragElastic={{ top: 0, bottom: 0.6 }}
          dragMomentum={false}
          onDragEnd={handleDragEnd}
        >
          <LazyBoundary>
            <SubagentDetailPanel
              entry={entry}
              onClose={onClose}
              onStop={onStop}
              onRequestDetail={onRequestDetail}
            />
          </LazyBoundary>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

import { lazy } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

import { LazyBoundary } from "@/components/lazy-boundary";
import { useMobileOverlayViewportStyle } from "@/hooks/use-mobile-overlay-viewport-style";
import type { WakeDetailPayload } from "@/stores/viewer-store";

const WakeDetailPanel = lazy(() =>
  import("@/domains/chat/components/wake-detail-panel").then((m) => ({
    default: m.WakeDetailPanel,
  })),
);

interface MobileWakeDetailOverlayProps {
  /** When `null`, the overlay renders nothing. */
  payload: WakeDetailPayload | null;
  /** Closes the overlay. */
  onClose: () => void;
}

/**
 * Mobile-only full-screen overlay that hosts the wake detail panel.
 *
 * A wake card's "View details" has to lead somewhere on a phone as well: the
 * desktop drawer does not render there, and unlike the skill panel there is no
 * standalone page to hand off to, since the wake hint exists only inside the
 * conversation that woke.
 *
 * **Mounting constraint**: must render inside `RootLayout`'s
 * `#viewport-overlays` portal, outside the main content wrapper.
 */
export function MobileWakeDetailOverlay({
  payload,
  onClose,
}: MobileWakeDetailOverlayProps) {
  const reduce = useReducedMotion();
  const shellStyle = useMobileOverlayViewportStyle();

  return (
    <AnimatePresence>
      {payload && (
        <motion.div
          key="mobile-wake-detail-overlay"
          className="fixed inset-x-0 z-30"
          style={shellStyle}
          initial={{ y: "100%", opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: "100%", opacity: 0 }}
          transition={
            reduce
              ? { duration: 0 }
              : { duration: 0.28, ease: [0.16, 1, 0.3, 1] }
          }
        >
          <LazyBoundary>
            <WakeDetailPanel payload={payload} onClose={onClose} />
          </LazyBoundary>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

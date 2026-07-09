import { lazy } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

import { LazyBoundary } from "@/components/lazy-boundary";
import { useMobileOverlayViewportStyle } from "@/hooks/use-mobile-overlay-viewport-style";
import type { SubagentEntry } from "@/domains/chat/subagent-store";

const SubagentDetailPanel = lazy(() =>
  import("@/domains/chat/components/subagent-detail-panel").then((m) => ({
    default: m.SubagentDetailPanel,
  })),
);

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

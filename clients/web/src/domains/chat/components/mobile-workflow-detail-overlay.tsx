import { lazy } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

import { LazyBoundary } from "@/components/lazy-boundary";
import { useMobileOverlayViewportStyle } from "@/hooks/use-mobile-overlay-viewport-style";
import type { WorkflowEntry } from "@/domains/chat/workflow-store";

const WorkflowDetailPanel = lazy(() =>
  import("@/domains/chat/components/workflow-detail-panel").then((m) => ({
    default: m.WorkflowDetailPanel,
  })),
);

interface MobileWorkflowDetailOverlayProps {
  /** When `null`, the overlay renders nothing. */
  entry: WorkflowEntry | null;
  /** Closes the overlay. */
  onClose: () => void;
  /** Stop a running workflow. */
  onStop?: (runId: string) => void;
  /** Request journal fetch for a workflow run. */
  onRequestJournal?: (runId: string) => void;
}

/**
 * Mobile-only full-screen overlay that hosts the workflow detail panel.
 *
 * **Mounting constraint**: must render inside `RootLayout`'s
 * `#viewport-overlays` portal, outside the main content wrapper.
 */
export function MobileWorkflowDetailOverlay({
  entry,
  onClose,
  onStop,
  onRequestJournal,
}: MobileWorkflowDetailOverlayProps) {
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
            <WorkflowDetailPanel
              entry={entry}
              onClose={onClose}
              onStop={onStop}
              onRequestJournal={onRequestJournal}
            />
          </LazyBoundary>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

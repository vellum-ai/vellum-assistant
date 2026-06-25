import { lazy } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

import { LazyBoundary } from "@/components/lazy-boundary";
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

  return (
    <AnimatePresence>
      {entry && (
        <motion.div
          key="mobile-detail-overlay"
          className="fixed inset-x-0 bottom-0 z-30 h-[100dvh]"
          style={{
            paddingTop: "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))",
            paddingBottom: "var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))",
            paddingLeft: "var(--safe-area-inset-left, env(safe-area-inset-left, 0px))",
            paddingRight: "var(--safe-area-inset-right, env(safe-area-inset-right, 0px))",
          }}
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

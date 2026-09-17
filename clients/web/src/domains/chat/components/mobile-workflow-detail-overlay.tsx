import { lazy } from "react";

import { MobileDetailSheet } from "@/domains/chat/components/mobile-detail-sheet";
import type { WorkflowEntry } from "@/domains/chat/workflow-store";

const WorkflowDetailPanel = lazy(() =>
  import("@/domains/chat/components/workflow-detail-panel").then((m) => ({
    default: m.WorkflowDetailPanel,
  })),
);

interface MobileWorkflowDetailOverlayProps {
  /** When `null`, closes the sheet. */
  entry: WorkflowEntry | null;
  /** Closes the overlay. */
  onClose: () => void;
  /** Stop a running workflow. */
  onStop?: (runId: string) => void;
  /** Request journal fetch for a workflow run. */
  onRequestJournal?: (runId: string) => void;
}

/** Mobile detail presentation, mounted under the viewport portal provider. */
export function MobileWorkflowDetailOverlay({
  entry,
  onClose,
  onStop,
  onRequestJournal,
}: MobileWorkflowDetailOverlayProps) {
  return (
    <MobileDetailSheet data={entry} onClose={onClose}>
      {(value) => (
        <WorkflowDetailPanel
          entry={value}
          onClose={onClose}
          onStop={onStop}
          onRequestJournal={onRequestJournal}
        />
      )}
    </MobileDetailSheet>
  );
}

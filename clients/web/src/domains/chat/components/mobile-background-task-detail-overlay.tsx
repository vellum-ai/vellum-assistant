import { lazy } from "react";

import { MobileDetailSheet } from "@/domains/chat/components/mobile-detail-sheet";
import type { BackgroundTaskEntry } from "@/domains/chat/background-task-store";

const BackgroundTaskDetailPanel = lazy(() =>
  import("@/domains/chat/components/background-task-detail-panel/background-task-detail-panel").then(
    (m) => ({ default: m.BackgroundTaskDetailPanel }),
  ),
);

interface MobileBackgroundTaskDetailOverlayProps {
  entry: BackgroundTaskEntry | null;
  onClose: () => void;
}

/** Mobile detail presentation, mounted under the viewport portal provider. */
export function MobileBackgroundTaskDetailOverlay({
  entry,
  onClose,
}: MobileBackgroundTaskDetailOverlayProps) {
  return (
    <MobileDetailSheet data={entry} onClose={onClose}>
      {(value) => (
        <BackgroundTaskDetailPanel
          entry={value} onClose={onClose}
        />
      )}
    </MobileDetailSheet>
  );
}

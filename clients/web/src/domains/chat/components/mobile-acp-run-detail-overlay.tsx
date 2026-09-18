import { lazy } from "react";

import { MobileDetailSheet } from "@/domains/chat/components/mobile-detail-sheet";
import type { AcpRunEntry } from "@/domains/chat/acp-run-store";

const AcpRunDetailPanel = lazy(() =>
  import("@/domains/chat/components/acp-run-detail-panel/acp-run-detail-panel").then(
    (m) => ({ default: m.AcpRunDetailPanel }),
  ),
);

interface MobileAcpRunDetailOverlayProps {
  entry: AcpRunEntry | null;
  onClose: () => void;
  /** Assistant that owns the run's parent conversation. */
  assistantId?: string | null;
}

/** Mobile detail presentation, mounted under the viewport portal provider. */
export function MobileAcpRunDetailOverlay({
  entry,
  onClose,
  assistantId,
}: MobileAcpRunDetailOverlayProps) {
  return (
    <MobileDetailSheet data={entry} onClose={onClose}>
      {(value) => (
        <AcpRunDetailPanel
          entry={value}
          onClose={onClose}
          assistantId={assistantId}
        />
      )}
    </MobileDetailSheet>
  );
}

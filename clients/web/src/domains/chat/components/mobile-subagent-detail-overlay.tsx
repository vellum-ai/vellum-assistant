import { lazy } from "react";

import { MobileDetailSheet } from "@/domains/chat/components/mobile-detail-sheet";
import type { SubagentEntry } from "@/domains/chat/subagent-store";

const SubagentDetailPanel = lazy(() =>
  import("@/domains/chat/components/subagent-detail-panel").then((m) => ({
    default: m.SubagentDetailPanel,
  })),
);

interface MobileSubagentDetailOverlayProps {
  /** When `null`, closes the sheet. */
  entry: SubagentEntry | null;
  /** Closes the overlay. */
  onClose: () => void;
  /** Stop a running subagent. */
  onStop?: (subagentId: string) => void;
  /** Request detail fetch for a subagent. */
  onRequestDetail?: (subagentId: string) => void;
  /** Assistant that owns the conversation the subagent was spawned from. */
  assistantId?: string | null;
}

/** Mobile detail presentation, mounted under the viewport portal provider. */
export function MobileSubagentDetailOverlay({
  entry,
  onClose,
  onStop,
  onRequestDetail,
  assistantId,
}: MobileSubagentDetailOverlayProps) {
  return (
    <MobileDetailSheet data={entry} onClose={onClose}>
      {(value) => (
        <SubagentDetailPanel
          entry={value}
          onClose={onClose}
          onStop={onStop}
          onRequestDetail={onRequestDetail}
          assistantId={assistantId}
        />
      )}
    </MobileDetailSheet>
  );
}

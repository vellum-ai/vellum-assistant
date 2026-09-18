import { lazy } from "react";

import { MobileDetailSheet } from "@/domains/chat/components/mobile-detail-sheet";
import type { ToolDetailPayload } from "@/stores/viewer-store";

const ToolDetailPanel = lazy(() =>
  import("@/domains/chat/components/tool-detail-panel").then((m) => ({
    default: m.ToolDetailPanel,
  })),
);

interface MobileToolDetailOverlayProps {
  /** When `null`, closes the sheet. */
  detail: ToolDetailPayload | null;
  /** Closes the overlay. */
  onClose: () => void;
  /** Assistant that owns the conversation the step belongs to. */
  assistantId?: string | null;
}

/** Mobile detail presentation, mounted under the viewport portal provider. */
export function MobileToolDetailOverlay({
  detail,
  onClose,
  assistantId,
}: MobileToolDetailOverlayProps) {
  return (
    <MobileDetailSheet data={detail} onClose={onClose}>
      {(value) => (
        <ToolDetailPanel
          detail={value}
          onClose={onClose}
          assistantId={assistantId}
        />
      )}
    </MobileDetailSheet>
  );
}

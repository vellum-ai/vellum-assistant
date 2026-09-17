import { lazy } from "react";

import { MobileDetailSheet } from "@/domains/chat/components/mobile-detail-sheet";
import type { ActivityStepsPayload } from "@/stores/viewer-store";

const ActivityStepsPanel = lazy(() =>
  import("@/domains/chat/components/activity-steps-panel").then((m) => ({
    default: m.ActivityStepsPanel,
  })),
);

interface MobileActivityStepsOverlayProps {
  /** When `null`, closes the sheet. */
  payload: ActivityStepsPayload | null;
  /** Closes the overlay. */
  onClose: () => void;
  /** Assistant that owns the conversation the activity group belongs to. */
  assistantId?: string | null;
}

/** Mobile detail presentation, mounted under the viewport portal provider. */
export function MobileActivityStepsOverlay({
  payload,
  onClose,
  assistantId,
}: MobileActivityStepsOverlayProps) {
  return (
    <MobileDetailSheet data={payload} onClose={onClose} testId="mobile-activity-steps-overlay">
      {(value) => (
        <ActivityStepsPanel
          payload={value}
          onClose={onClose}
          assistantId={assistantId}
        />
      )}
    </MobileDetailSheet>
  );
}

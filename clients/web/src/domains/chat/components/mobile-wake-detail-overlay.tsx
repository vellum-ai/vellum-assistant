import { lazy } from "react";

import { MobileDetailSheet } from "@/domains/chat/components/mobile-detail-sheet";
import type { WakeDetailPayload } from "@/stores/viewer-store";

const WakeDetailPanel = lazy(() =>
  import("@/domains/chat/components/wake-detail-panel").then((m) => ({
    default: m.WakeDetailPanel,
  })),
);

interface MobileWakeDetailOverlayProps {
  /** When `null`, closes the sheet. */
  payload: WakeDetailPayload | null;
  /** Closes the overlay. */
  onClose: () => void;
}

/**
 * Mobile detail presentation for a wake card, mounted under the viewport
 * portal provider.
 *
 * A wake card's "View details" has to lead somewhere on a phone as well: the
 * desktop drawer does not render there, and unlike the skill panel there is no
 * standalone page to hand off to, since the wake hint exists only inside the
 * conversation that woke.
 */
export function MobileWakeDetailOverlay({
  payload,
  onClose,
}: MobileWakeDetailOverlayProps) {
  return (
    <MobileDetailSheet data={payload} onClose={onClose}>
      {(value) => <WakeDetailPanel payload={value} onClose={onClose} />}
    </MobileDetailSheet>
  );
}

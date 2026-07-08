import { lazy } from "react";

import { LazyBoundary } from "@/components/lazy-boundary";
import { useMobileOverlayViewportStyle } from "@/hooks/use-mobile-overlay-viewport-style";
import type { AcpRunEntry } from "@/domains/chat/acp-run-store";

const AcpRunDetailPanel = lazy(() =>
  import(
    "@/domains/chat/components/acp-run-detail-panel/acp-run-detail-panel"
  ).then((m) => ({ default: m.AcpRunDetailPanel })),
);

interface MobileAcpRunDetailOverlayProps {
  entry: AcpRunEntry | null;
  onClose: () => void;
}

/**
 * Mobile-only full-screen overlay that hosts the ACP run detail panel.
 *
 * **Mounting constraint**: must render inside `RootLayout`'s
 * `#viewport-overlays` portal, outside the main content wrapper.
 */
export function MobileAcpRunDetailOverlay({
  entry,
  onClose,
}: MobileAcpRunDetailOverlayProps) {
  const shellStyle = useMobileOverlayViewportStyle();

  if (!entry) {
    return null;
  }

  return (
    <div className="fixed inset-x-0 z-30" style={shellStyle}>
      <LazyBoundary>
        <AcpRunDetailPanel entry={entry} onClose={onClose} />
      </LazyBoundary>
    </div>
  );
}

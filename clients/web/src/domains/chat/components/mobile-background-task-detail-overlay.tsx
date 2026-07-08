import { lazy } from "react";

import { LazyBoundary } from "@/components/lazy-boundary";
import { useMobileOverlayViewportStyle } from "@/hooks/use-mobile-overlay-viewport-style";
import type { BackgroundTaskEntry } from "@/domains/chat/background-task-store";

const BackgroundTaskDetailPanel = lazy(() =>
  import(
    "@/domains/chat/components/background-task-detail-panel/background-task-detail-panel"
  ).then((m) => ({ default: m.BackgroundTaskDetailPanel })),
);

interface MobileBackgroundTaskDetailOverlayProps {
  entry: BackgroundTaskEntry | null;
  onClose: () => void;
}

/**
 * Mobile-only full-screen overlay that hosts the background-task detail panel.
 *
 * **Mounting constraint**: must render inside `RootLayout`'s
 * `#viewport-overlays` portal, outside the main content wrapper.
 */
export function MobileBackgroundTaskDetailOverlay({
  entry,
  onClose,
}: MobileBackgroundTaskDetailOverlayProps) {
  const shellStyle = useMobileOverlayViewportStyle();

  if (!entry) {
    return null;
  }

  return (
    <div className="fixed inset-x-0 z-30" style={shellStyle}>
      <LazyBoundary>
        <BackgroundTaskDetailPanel entry={entry} onClose={onClose} />
      </LazyBoundary>
    </div>
  );
}

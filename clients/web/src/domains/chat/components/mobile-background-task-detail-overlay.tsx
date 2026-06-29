import { lazy } from "react";

import { LazyBoundary } from "@/components/lazy-boundary";
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
  if (!entry) {
    return null;
  }

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-30 h-[100dvh]"
      style={{
        paddingTop: "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))",
        paddingBottom: "var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))",
        paddingLeft: "var(--safe-area-inset-left, env(safe-area-inset-left, 0px))",
        paddingRight: "var(--safe-area-inset-right, env(safe-area-inset-right, 0px))",
      }}
    >
      <LazyBoundary>
        <BackgroundTaskDetailPanel entry={entry} onClose={onClose} />
      </LazyBoundary>
    </div>
  );
}

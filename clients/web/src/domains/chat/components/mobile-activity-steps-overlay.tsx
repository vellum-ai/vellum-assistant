import { lazy, type MouseEvent } from "react";

import { LazyBoundary } from "@/components/lazy-boundary";
import type { ActivityStepsPayload } from "@/stores/viewer-store";

const ActivityStepsPanel = lazy(() =>
  import("@/domains/chat/components/activity-steps-panel").then((m) => ({
    default: m.ActivityStepsPanel,
  })),
);

interface MobileActivityStepsOverlayProps {
  /** When `null`, the overlay renders nothing. */
  payload: ActivityStepsPayload | null;
  /** Closes the overlay. */
  onClose: () => void;
}

/**
 * Mobile-only full-screen overlay that hosts the activity-steps panel (one
 * activity group's full timeline, with in-panel drill-in to step details).
 *
 * **Mounting constraint**: must render inside `RootLayout`'s
 * `#viewport-overlays` portal, outside the main content wrapper.
 */
export function MobileActivityStepsOverlay({
  payload,
  onClose,
}: MobileActivityStepsOverlayProps) {
  if (!payload) {
    return null;
  }

  const handleBackdropClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-30 h-[100dvh] bg-black/40"
      style={{
        paddingTop: "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))",
        paddingBottom:
          "var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))",
        paddingLeft:
          "var(--safe-area-inset-left, env(safe-area-inset-left, 0px))",
        paddingRight:
          "var(--safe-area-inset-right, env(safe-area-inset-right, 0px))",
      }}
      onClick={handleBackdropClick}
    >
      <LazyBoundary>
        <ActivityStepsPanel payload={payload} onClose={onClose} />
      </LazyBoundary>
    </div>
  );
}

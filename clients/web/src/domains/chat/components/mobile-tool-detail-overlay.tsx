import { lazy, type MouseEvent } from "react";

import { LazyBoundary } from "@/components/lazy-boundary";
import type { ToolDetailPayload } from "@/stores/viewer-store";

const ToolDetailPanel = lazy(() =>
  import("@/domains/chat/components/tool-detail-panel").then((m) => ({
    default: m.ToolDetailPanel,
  })),
);

interface MobileToolDetailOverlayProps {
  /** When `null`, the overlay renders nothing. */
  detail: ToolDetailPayload | null;
  /** Closes the overlay. */
  onClose: () => void;
  /** Opens the trust-rule editor for the displayed tool call. */
  onRiskBadgeClick?: () => void;
}

/**
 * Mobile-only full-screen overlay that hosts the tool-call detail panel.
 *
 * **Mounting constraint**: must render inside `RootLayout`'s
 * `#viewport-overlays` portal, outside the main content wrapper.
 */
export function MobileToolDetailOverlay({
  detail,
  onClose,
  onRiskBadgeClick,
}: MobileToolDetailOverlayProps) {
  if (!detail) {
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
        <ToolDetailPanel detail={detail} onClose={onClose} onRiskBadgeClick={onRiskBadgeClick} />
      </LazyBoundary>
    </div>
  );
}

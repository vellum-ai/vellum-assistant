import { lazy } from "react";

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
}

/**
 * Mobile-only full-screen overlay that hosts the tool-call detail panel.
 *
 * **Mounting constraint**: must render outside `RootLayout`'s inner
 * transformed wrapper (see `src/root-layout.tsx`) so
 * `position: fixed` anchors to the viewport's initial containing block
 * rather than the keyboard-following transform `RootLayout` applies when
 * the soft keyboard opens.
 *
 * https://www.w3.org/TR/css-transforms-1/#transform-rendering
 */
export function MobileToolDetailOverlay({
  detail,
  onClose,
}: MobileToolDetailOverlayProps) {
  if (!detail) {
    return null;
  }

  return (
    <div className="fixed inset-x-0 bottom-0 z-30 h-[100dvh]">
      <LazyBoundary>
        <ToolDetailPanel detail={detail} onClose={onClose} />
      </LazyBoundary>
    </div>
  );
}

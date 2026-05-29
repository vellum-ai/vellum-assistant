import { lazy } from "react";

import { LazyBoundary } from "@/components/lazy-boundary";
import type { SubagentEntry } from "@/domains/chat/subagent-store";

const SubagentDetailPanel = lazy(() =>
  import("@/domains/chat/components/subagent-detail-panel").then((m) => ({
    default: m.SubagentDetailPanel,
  })),
);

interface MobileSubagentDetailOverlayProps {
  /** When `null`, the overlay renders nothing. */
  entry: SubagentEntry | null;
  /** Closes the overlay. */
  onClose: () => void;
  /** Stop a running subagent. */
  onStop?: (subagentId: string) => void;
  /** Request detail fetch for a subagent. */
  onRequestDetail?: (subagentId: string) => void;
}

/**
 * Mobile-only full-screen overlay that hosts the subagent detail panel.
 *
 * **Mounting constraint**: must render inside `RootLayout`'s
 * `#viewport-overlays` portal, outside the main content wrapper.
 */
export function MobileSubagentDetailOverlay({
  entry,
  onClose,
  onStop,
  onRequestDetail,
}: MobileSubagentDetailOverlayProps) {
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
        <SubagentDetailPanel
          entry={entry}
          onClose={onClose}
          onStop={onStop}
          onRequestDetail={onRequestDetail}
        />
      </LazyBoundary>
    </div>
  );
}

import type { ReactNode } from "react";

import { ResizablePanel } from "@vellumai/design-library";

/**
 * Desktop master–detail drawer shared by the Activity and Schedules pages:
 * the section list on the left, the selected item's detail sliding in on the
 * right. `detailKey` re-mounts the animated wrapper on each new selection so
 * the slide-in replays when switching between items (not just on the initial
 * null → open transition).
 */
export function DetailDrawer({
  storageKey,
  detailKey,
  section,
  detail,
}: {
  /** ResizablePanel persistence key — one per page so widths don't couple. */
  storageKey: string;
  detailKey?: string;
  section: ReactNode;
  detail: ReactNode;
}) {
  return (
    <ResizablePanel
      className="min-h-0 flex-1"
      storageKey={storageKey}
      defaultRightWidth={480}
      minLeftWidth={320}
      minRightWidth={400}
      hideDivider
      left={
        <div className="flex min-h-0 flex-1 flex-col pr-[var(--app-spacing-lg)]">
          {section}
        </div>
      }
      right={
        <div key={detailKey} className="home-detail-drawer">
          {detail}
        </div>
      }
    />
  );
}

/**
 * Mobile companion to {@link DetailDrawer}: the detail panel takes over the
 * whole screen instead of docking beside the list, padded past the device
 * safe areas.
 */
export function MobileDetailOverlay({ children }: { children: ReactNode }) {
  return (
    <div
      className="fixed inset-0 z-30 bg-[var(--surface-overlay)]"
      style={{
        paddingTop: "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))",
        paddingBottom:
          "var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))",
      }}
    >
      {children}
    </div>
  );
}

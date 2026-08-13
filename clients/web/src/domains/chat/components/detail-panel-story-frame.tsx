/**
 * Story frame for the side-drawer detail panels.
 *
 * Every detail panel reaches the screen as `AnimatedRightDrawer`'s `right`
 * slot in `chat-content-layout`, so its width belongs to the drawer, not to
 * the panel and not to whoever frames it. A story that picks its own box
 * reviews the panel at a width the app cannot produce: truncation, wrapping
 * and column geometry all read as fine at 440 or 560px while the shipped
 * drawer is 400px and clips them.
 *
 * So the width here is imported from the drawer rather than written down
 * again, and it is the minimum rather than a comfortable one: default and
 * minimum are the same number (see `animated-right-drawer.tsx`), which makes
 * 400px both the width a panel opens at and the narrowest it must survive.
 * Nothing else about the drawer is reproduced. The split, the open animation
 * and the drag handle are the drawer's own contract, reviewed in its own
 * story, and pulling them into nine panel stories would only add a 340ms
 * entrance wipe that leaves a first-frame capture blank.
 *
 * Height is the viewport, where the app's is the viewport minus
 * `chat-layout`'s `p-4`. The panels scroll their bodies, so height is not a
 * contract these stories review; width is.
 */

import type { ReactNode } from "react";

import { RIGHT_DRAWER_MIN_WIDTH_PX } from "@/domains/chat/components/animated-right-drawer";

export function DetailPanelStoryFrame({ children }: { children: ReactNode }) {
  return (
    <div
      className="h-screen shrink-0 overflow-hidden"
      style={{ width: RIGHT_DRAWER_MIN_WIDTH_PX }}
    >
      {children}
    </div>
  );
}

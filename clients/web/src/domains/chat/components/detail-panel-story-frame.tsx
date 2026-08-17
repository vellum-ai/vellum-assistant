/**
 * Story frame for the side-drawer detail panels.
 *
 * Every detail panel reaches the screen as `AnimatedRightDrawer`'s `right`
 * slot, so its width is the drawer's. The frame reproduces that width and
 * nothing else about the drawer: the split, the open animation and the drag
 * handle are the drawer's own contract, reviewed in its own story.
 *
 * The width is the drawer's minimum, which is also its default, so a panel
 * framed here sits at the width it opens at in any container wide enough to
 * hold it. A container narrower than that caps the drawer below this width, a
 * regime the frame does not reach, so it understates how narrow a panel can
 * get rather than overstating it.
 *
 * Height is the viewport, a little taller than the app's `<main>`; the panels
 * scroll their bodies, so width is the contract under review here and height
 * is not.
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

/**
 * Story frame for the side-drawer detail panels.
 *
 * Every detail panel reaches the screen as `AnimatedRightDrawer`'s `right`
 * slot, so the story mounts the real drawer around it and states no geometry
 * of its own. The opening width, the cap a too-narrow container applies to it,
 * and the drag handle all come from the drawer, so narrowing the Storybook
 * viewport walks a panel through the same widths the app puts it through,
 * including the capped regime below the drawer's own minimum. A panel the app
 * opens wider than the drawer's default names its own `defaultWidth`.
 *
 * `left` is empty. In the app it holds the chat column, which the drawer needs
 * only as the flex sibling it takes its width from; an empty box plays that
 * part exactly, and drawing a stand-in chat would be scenery the app does not
 * ship. No `storageKey` either, so a story opens at the width it asks for
 * rather than wherever the last reviewer dragged it.
 */

import type { ReactNode } from "react";

import { AnimatedRightDrawer } from "@/domains/chat/components/animated-right-drawer";

interface DetailPanelStoryFrameProps {
  children: ReactNode;
  /** Opening width, for a panel the app opens wider than the drawer's default. */
  defaultWidth?: number;
}

export function DetailPanelStoryFrame({
  children,
  defaultWidth,
}: DetailPanelStoryFrameProps) {
  return (
    <div className="h-screen w-full bg-[var(--surface-base)]">
      <AnimatedRightDrawer
        open
        left={null}
        right={children}
        defaultWidth={defaultWidth}
      />
    </div>
  );
}

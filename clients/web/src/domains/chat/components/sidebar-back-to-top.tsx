/**
 * "Back to top" pill for the sidebar's conversation list.
 *
 * The flat list has no ceiling, so the scrollport it lives in can run to tens
 * of thousands of pixels. Getting back to the view switch and the pinned rows
 * should not be a scroll marathon.
 *
 * Sticky rather than absolutely positioned, so it rides the bottom edge of
 * the scrollport without needing to know about the footer or the overlay's
 * floating pills.
 *
 * Visibility is a prop rather than conditional mounting so the pill can fade,
 * and while hidden it stops taking pointer events and leaves the tab order.
 *
 * It reuses the `Button` primitive and only overrides what floating over a
 * list requires: a pill shape, a shadow, and two opaque surfaces. The neutral
 * surface follows `GoToNewest`, the transcript's equivalent affordance.
 */

import { ArrowUp } from "lucide-react";

import { Button, cn } from "@vellumai/design-library";

export interface SidebarBackToTopProps {
  visible: boolean;
  onClick: () => void;
}

export function SidebarBackToTop({ visible, onClick }: SidebarBackToTopProps) {
  return (
    /* `h-0` so the pill reserves no room at the end of the list: it floats
       over the rows, and the list should run right up to the footer. */
    <div className="pointer-events-none sticky bottom-2 z-10 flex h-0 items-end justify-center">
      <Button
        variant="ghost"
        leftIcon={<ArrowUp className="h-4 w-4" />}
        onClick={onClick}
        aria-hidden={!visible}
        tabIndex={visible ? undefined : -1}
        /* Both surfaces are opaque on purpose. The pill floats over the list
           with nothing solid behind it, and the usual `--surface-hover` is a
           6% wash meant to layer onto something, so it would read as the
           button going transparent on hover. */
        className={cn(
          "rounded-full bg-[var(--surface-lift)] shadow-md",
          "hover:bg-[var(--surface-active)]",
          "transition-opacity duration-150",
          visible ? "pointer-events-auto" : "pointer-events-none opacity-0",
        )}
      >
        Back to top
      </Button>
    </div>
  );
}

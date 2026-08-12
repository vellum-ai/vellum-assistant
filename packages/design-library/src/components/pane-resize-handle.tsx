import type { ComponentProps, ReactNode } from "react";

import { cn } from "../utils/cn";
import type { ResizablePaneHandleProps } from "../hooks/use-resizable-pane";

export interface PaneResizeHandleProps
  extends Omit<ComponentProps<"div">, keyof ResizablePaneHandleProps>,
    ResizablePaneHandleProps {
  /** The divider line and grab affordance. Presentation belongs to the caller. */
  children?: ReactNode;
}

/**
 * The draggable edge of a resizable pane: a focusable `role="separator"` that
 * reports its position and moves with the arrow keys.
 *
 * Takes its behaviour and ARIA wholesale from `useResizablePane`'s
 * `handleProps` and contributes only the hit area and focus ring, so the two
 * cannot disagree about what the separator claims. Per [ARIA 1.2][sep] a
 * separator is a widget role only when it is focusable; a divider that
 * declares the role without `tabindex` announces as decorative page furniture
 * while being the only control over the pane's size.
 *
 * `Enter` (collapse and restore the primary pane) is deliberately absent. APG
 * lists it as conditional on the implementation supporting collapse, and no
 * pane here can collapse: they all clamp to a non-zero minimum.
 *
 * [sep]: https://www.w3.org/TR/wai-aria-1.2/#separator
 * @see https://www.w3.org/WAI/ARIA/apg/patterns/windowsplitter/
 */
export function PaneResizeHandle({
  className,
  children,
  ...handleProps
}: PaneResizeHandleProps) {
  return (
    <div
      {...handleProps}
      data-slot="pane-resize-handle"
      className={cn(
        "cursor-col-resize",
        // A focusable control needs a visible focus indicator (WCAG 2.4.7).
        // The handle is a thin column, so a ring reads better than an inset
        // outline at that width.
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

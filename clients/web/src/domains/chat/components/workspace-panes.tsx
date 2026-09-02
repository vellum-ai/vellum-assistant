import { type ReactNode } from "react";

import { ResizablePanel } from "@vellumai/design-library";

import type { PanePresentation } from "@/stores/pane-state";

export interface WorkspacePanesProps {
  /**
   * How the two surfaces are arranged.
   *
   * `"bottom"` is not accepted: on a narrow viewport the panes are still
   * presented by the mobile overlays, so this component has nothing to draw
   * for it and a caller that has one is asking the wrong thing.
   */
  presentation: Exclude<PanePresentation, "bottom">;
  /** The surface with the room. */
  primary: ReactNode;
  /** The surface sharing it. Drawn only when the arrangement shows it. */
  secondary?: ReactNode;
}

/**
 * Draws the workspace's two surfaces in the arrangement it is given.
 *
 * The secondary sits to the left of the primary: the app is the surface being
 * worked on, so it takes the sized pane on the right and the conversation
 * fills what is left.
 *
 * `"full"` and `"single"` draw the same picture. A collapsed secondary is
 * still open and is what the primary expands over, so the difference is in
 * what the workspace holds rather than in what it shows.
 */
export function WorkspacePanes({
  presentation,
  primary,
  secondary,
}: WorkspacePanesProps) {
  if (presentation === "side" && secondary != null) {
    return (
      <ResizablePanel
        // Widths persist under this key, so a pane keeps the size it was
        // dragged to.
        storageKey="appEditPanelWidth"
        hideDivider
        defaultRightWidth={400}
        minLeftWidth={300}
        minRightWidth={400}
        left={secondary}
        right={primary}
      />
    );
  }
  return primary;
}

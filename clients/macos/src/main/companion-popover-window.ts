import type { BrowserWindow, Rectangle } from "electron";

import {
  COMPANION_POPOVER_INSET,
  COMPANION_POPOVER_MAX_HEIGHT,
  COMPANION_POPOVER_MAX_WIDTH,
  type CompanionPopover,
} from "@vellumai/ipc-contract";
import {
  createFloatingWindow,
  getFloatingWindow,
} from "@vellumai/electron-desktop/floating-window";

/**
 * The popover beside the companion: what the assistant needs the user to see
 * or answer while they are away from the app's window, such as a tool
 * approval, an image or a link (see `CompanionPopover`).
 *
 * **Its own window, sized to what it draws.** The companion's canvas reserves
 * a fixed card's room above the pill and none beside a side-docked column, and
 * an image or a long approval needs more than that room. A window the size of
 * the card is clickable everywhere it is drawn, so it needs none of the
 * canvas's hit-testing either.
 *
 * **Shown only once measured.** The window is sized from the size its page
 * reports for the popover it is drawing, so a new popover is not shown until
 * its own size has arrived. Otherwise it would open at the size of the one
 * before it.
 *
 * Unfocusable like the surface, so a press on it never takes the keyboard
 * from the app the user is working in. The one exception is a credential form
 * on screen: it is lent key status for as long as the form is up, with
 * `setFocusable` both ways and never `blur()`.
 */

export const POPOVER_KIND = "companion-popover";
const POPOVER_ROUTE = "/floating/companion-popover";

/** How far the popover keeps from the surface it is drawn beside, in points. */
export const POPOVER_GAP = 8;

/** How far the popover keeps from the edges of the work area, in points. */
const POPOVER_MARGIN = 8;

/** Which side of the surface the popover is drawn on. */
export type PopoverSide = "above" | "below" | "left" | "right";

/**
 * Where the popover hangs from: the point the surface is drawn around, the
 * side to draw on, and how far from that point the surface reaches toward
 * that side.
 */
export interface CompanionPopoverAnchor {
  centre: { x: number; y: number };
  side: PopoverSide;
  clearance: number;
  workArea: Rectangle;
}

const OPPOSITE: Record<PopoverSide, PopoverSide> = {
  above: "below",
  below: "above",
  left: "right",
  right: "left",
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), Math.max(min, max));

/**
 * The popover's window bounds for an anchor and a content height.
 *
 * Centred on the surface along the side it hangs from, and moved back inside
 * the work area. When the chosen side has no room for the whole popover it
 * goes on the opposite side instead: a popover pushed back on screen on its
 * own side would sit over the surface it belongs to.
 *
 * Pure and exported for its tests.
 */
export const popoverBoundsFor = (
  anchor: CompanionPopoverAnchor,
  size: { width: number; height: number },
): Rectangle => {
  const { width, height } = size;
  const { centre, clearance, workArea } = anchor;
  const reach = clearance + POPOVER_GAP - COMPANION_POPOVER_INSET;
  const fits = (side: PopoverSide): boolean => {
    switch (side) {
      case "above":
        return centre.y - reach - height >= workArea.y + POPOVER_MARGIN;
      case "below":
        return (
          centre.y + reach + height <=
          workArea.y + workArea.height - POPOVER_MARGIN
        );
      case "left":
        return centre.x - reach - width >= workArea.x + POPOVER_MARGIN;
      case "right":
        return (
          centre.x + reach + width <=
          workArea.x + workArea.width - POPOVER_MARGIN
        );
    }
  };
  const side =
    fits(anchor.side) || !fits(OPPOSITE[anchor.side])
      ? anchor.side
      : OPPOSITE[anchor.side];

  let x: number;
  let y: number;
  switch (side) {
    case "above":
      x = centre.x - width / 2;
      y = centre.y - reach - height;
      break;
    case "below":
      x = centre.x - width / 2;
      y = centre.y + reach;
      break;
    case "left":
      x = centre.x - reach - width;
      y = centre.y - height / 2;
      break;
    case "right":
      x = centre.x + reach;
      y = centre.y - height / 2;
      break;
  }
  return {
    x: Math.round(
      clamp(
        x,
        workArea.x + POPOVER_MARGIN,
        workArea.x + workArea.width - width - POPOVER_MARGIN,
      ),
    ),
    y: Math.round(
      clamp(
        y,
        workArea.y + POPOVER_MARGIN,
        workArea.y + workArea.height - height - POPOVER_MARGIN,
      ),
    ),
    width,
    height,
  };
};

/**
 * The size a page reported, bounded: at least a row of buttons, at most the
 * popover's ceilings, whole points.
 */
export const popoverSizeFor = (reported: {
  width: number;
  height: number;
}): { width: number; height: number } => ({
  width: Math.round(clamp(reported.width, 120, COMPANION_POPOVER_MAX_WIDTH)),
  height: Math.round(clamp(reported.height, 48, COMPANION_POPOVER_MAX_HEIGHT)),
});

/** The size the page last reported, and for which popover. */
let measured: {
  id: string;
  kind: CompanionPopover["kind"];
  width: number;
  height: number;
} | null = null;

/** Whether the window has been lent key status for a form. */
let keyLent = false;

/**
 * Put the popover where it belongs for what is being shown and where the
 * surface is, or take it off the screen.
 *
 * Idempotent, and run whenever any of it can have changed: every state push,
 * the surface moving, and the page reporting a size. `anchor` is null when
 * there is no surface on screen to draw beside, and `show` is false when the
 * popover is put off or carried on the call's bar instead; either takes the
 * window away. `keyboard` asks for key status, for a form that takes typing.
 */
export const syncCompanionPopover = (
  popover: CompanionPopover | undefined,
  anchor: CompanionPopoverAnchor | null,
  options: { show: boolean; keyboard: boolean },
): void => {
  const existing = getFloatingWindow(POPOVER_KIND);
  if (popover === undefined || anchor === null || !options.show) {
    if (existing !== null) {
      releaseKey(existing);
      existing.hide();
    }
    return;
  }
  const win = existing ?? openPopoverWindow();
  if (measured?.id !== popover.id) {
    // The page has not drawn this popover yet. A popover of the same kind
    // already on screen (the list after one of its approvals is answered)
    // stays where it is until the new size lands; anything else is kept
    // hidden rather than shown at the last one's size.
    if (!(win.isVisible() && measured?.kind === popover.kind)) {
      releaseKey(win);
      win.hide();
    }
    return;
  }
  const bounds = popoverBoundsFor(anchor, measured);
  const current = win.getBounds();
  if (
    current.x !== bounds.x ||
    current.y !== bounds.y ||
    current.width !== bounds.width ||
    current.height !== bounds.height
  ) {
    win.setBounds(bounds);
  }
  if (!win.isVisible()) {
    win.showInactive();
  }
  if (options.keyboard && !keyLent) {
    keyLent = true;
    win.setFocusable(true);
    win.focus();
  } else if (!options.keyboard) {
    releaseKey(win);
  }
};

/**
 * Give key status back. `setFocusable(false)` alone: on macOS `blur()` is
 * `orderOut` then `orderBack`, which flashes a panel and drops its mouse.
 */
const releaseKey = (win: BrowserWindow): void => {
  if (!keyLent) {
    return;
  }
  keyLent = false;
  win.setFocusable(false);
};

/**
 * Record the size the page measured for a popover. Answers whether it moved,
 * so the caller knows a sync is due.
 */
export const setCompanionPopoverSize = (
  popover: CompanionPopover,
  size: { width: number; height: number },
): boolean => {
  const next = popoverSizeFor(size);
  if (
    measured?.id === popover.id &&
    measured.width === next.width &&
    measured.height === next.height
  ) {
    return false;
  }
  measured = { id: popover.id, kind: popover.kind, ...next };
  return true;
};

export const closeCompanionPopover = (): void => {
  measured = null;
  keyLent = false;
  getFloatingWindow(POPOVER_KIND)?.close();
};

/**
 * Build the popover's window, hidden. It is shown by the sync that follows
 * its page reporting a height.
 */
const openPopoverWindow = (): BrowserWindow => {
  const win = createFloatingWindow({
    kind: POPOVER_KIND,
    route: POPOVER_ROUTE,
    // At the ceilings, so the page first lays its card out at its own size
    // rather than squeezed into a window sized for nothing yet.
    width: COMPANION_POPOVER_MAX_WIDTH,
    height: COMPANION_POPOVER_MAX_HEIGHT,
    browserWindow: {
      // The card draws its own shadow inside the window's inset.
      hasShadow: false,
      focusable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      backgroundColor: "#00000000",
    },
  });
  win.hide();
  win.on("closed", () => {
    measured = null;
    keyLent = false;
  });
  return win;
};

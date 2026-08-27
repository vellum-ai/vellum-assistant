import type { MenuItemConstructorOptions } from "electron";

import {
  COMPANION_SIZE_AXES,
  COMPANION_SIZES,
  type CompanionSize,
  type CompanionSizeAxis,
} from "@vellumai/ipc-contract";

/**
 * Menu wording for each companion size.
 *
 * Here rather than in the contract: the contract carries what the two processes
 * send each other, and these are words on a menu. The point sizes are not in
 * the labels: "88pt" means nothing next to a floating avatar, and the sizes are
 * meant to be picked by looking at the result.
 *
 * One table rather than a literal per menu, since the tray and the surface's
 * own right-click both offer the steps. A user who met "Large" in one place and
 * "Big" in the other would reasonably wonder whether they were setting the same
 * thing.
 */
const COMPANION_SIZE_LABELS: Record<CompanionSize, string> = {
  small: "Small",
  medium: "Medium",
  large: "Large",
  huge: "Huge",
  ridiculous: "Ridiculous",
};

/**
 * Menu wording for each of the two things a user sizes.
 *
 * Sentence case, and the noun first: the submenus sit among items that say what
 * they act on ("Show Companion", "Hide Companion"), and a user scanning for the
 * creature reads "Avatar" before they read "size".
 *
 * Here beside the steps themselves, and for the same reason: both menus that
 * offer the sizes offer them under these two headings, and a user who met
 * "Avatar size" in one place and "Creature size" in the other would reasonably
 * wonder whether they were setting the same thing.
 */
const COMPANION_SIZE_AXIS_LABELS: Record<CompanionSizeAxis, string> = {
  avatar: "Avatar size",
  options: "Options size",
};

/**
 * The size pickers, as every menu that offers them draws them.
 *
 * One submenu per axis, since the creature and the controls beside it are sized
 * separately and a single picker could only ever move both. The steps sit under
 * those headings rather than flat: a named submenu says what its five words are
 * before it shows them, and leaves the menu around it short enough to read at a
 * glance.
 *
 * Named steps rather than a slider, because the avatar's box is not a style:
 * the canvas, the pill's reach and the card's height are all derived from it,
 * so a continuous scale would be a layout nobody had ever looked at. Radio
 * items, since each axis is one choice and the menu has to show which step is
 * in effect.
 *
 * Built here rather than in each menu, for the reason the wording above is: a
 * later axis, label, checked state or click behaviour would otherwise reach the
 * tray and leave the surface's own right-click describing the same setting
 * differently.
 *
 * `enabled` is for the menu that offers the sizes beside a way to hide the
 * surface: the items stand down rather than disappear while it is hidden, since
 * they say the sizes are still something the companion has.
 */
export const companionSizeSubmenus = (
  current: Record<CompanionSizeAxis, CompanionSize>,
  pick: (axis: CompanionSizeAxis, size: CompanionSize) => void,
  options?: { enabled?: boolean },
): MenuItemConstructorOptions[] =>
  COMPANION_SIZE_AXES.map((axis) => ({
    label: COMPANION_SIZE_AXIS_LABELS[axis],
    enabled: options?.enabled ?? true,
    submenu: COMPANION_SIZES.map((size) => ({
      label: COMPANION_SIZE_LABELS[size],
      type: "radio" as const,
      checked: current[axis] === size,
      click: () => {
        pick(axis, size);
      },
    })),
  }));

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
 * The vocabulary {@link companionSizeSubmenus} draws the steps from, which is
 * the one place the wording is decided for every menu that offers them.
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
 * creature reads "Avatar" before they read "size". The sentence case is the
 * design's wording, against the Title Case of the tray items beside it.
 *
 * The headings' half of the same vocabulary: {@link companionSizeSubmenus}
 * titles its submenus from here, so every menu that offers the sizes offers
 * them under these two words.
 */
const COMPANION_SIZE_AXIS_LABELS: Record<CompanionSizeAxis, string> = {
  avatar: "Avatar size",
  options: "Options size",
};

/**
 * The size pickers, as every menu that offers them draws them.
 *
 * One submenu per axis, since a single picker could only ever move both. One
 * builder rather than a literal per menu: an axis, label, checked state or
 * click behaviour added in one place would otherwise leave the tray and the
 * surface's own right-click describing the same setting differently.
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

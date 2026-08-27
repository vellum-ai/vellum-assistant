import type { CompanionSize, CompanionSizeAxis } from "@vellumai/ipc-contract";

/**
 * Menu wording for each companion size.
 *
 * Here rather than in the contract: the contract carries what the two processes
 * send each other, and these are words on a menu. The point sizes are not in
 * the labels: "88pt" means nothing next to a floating avatar, and the sizes are
 * meant to be picked by looking at the result.
 *
 * In a module of its own because two menus offer them now, the tray's and the
 * surface's own right-click, and those live in different packages. A user who
 * met "Large" in one place and "Big" in the other would reasonably wonder
 * whether they were setting the same thing.
 */
export const COMPANION_SIZE_LABELS: Record<CompanionSize, string> = {
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
export const COMPANION_SIZE_AXIS_LABELS: Record<CompanionSizeAxis, string> = {
  avatar: "Avatar size",
  options: "Options size",
};

import { type ReactNode } from "react";

import { cn } from "../utils/cn";

import {
  acceleratorToAriaKeyShortcuts,
  formatAcceleratorHint,
} from "./shortcut-keys";

/**
 * The right-aligned column of a menu row, shared by `Menu` and `ContextMenu`
 * so a key hint and a status glyph sit on the same baseline in the same
 * colour across both primitives.
 *
 * The two slots differ in what they mean to a screen reader, which is why
 * they are separate components rather than one with a flag: a key hint
 * repeats what `aria-keyshortcuts` already announces and so is hidden, while
 * trailing content is part of what the row says and stays in the accessible
 * name.
 */

const asideBase = [
  "pl-4 text-body-small-default tracking-wide",
  "text-[var(--content-tertiary)]",
].join(" ");

interface MenuItemShortcutProps {
  /** Electron accelerator, e.g. `"CmdOrCtrl+Shift+P"`. */
  readonly accelerator: string;
  /**
   * Whether this element pushes itself to the right edge. False when a
   * trailing slot precedes it and has already taken the free space.
   */
  readonly push?: boolean;
}

/**
 * The drawn key hint. Hidden from assistive tech, which reads the binding
 * from the item's `aria-keyshortcuts` instead.
 */
export function MenuItemShortcut({
  accelerator,
  push = true,
}: MenuItemShortcutProps) {
  return (
    <span
      data-slot="menu-item-shortcut"
      aria-hidden
      className={cn(asideBase, push && "ml-auto")}
    >
      {formatAcceleratorHint(accelerator)}
    </span>
  );
}

/**
 * The attributes a row carries when it draws a key hint, for spreading onto
 * the item element. Deriving the announced binding here, from the accelerator
 * the glyphs are drawn from, is what keeps a hidden hint from becoming a
 * shortcut assistive tech never hears about: a row cannot have one without
 * the other.
 */
export function menuItemShortcutProps(accelerator: string | undefined): {
  "aria-keyshortcuts"?: string;
} {
  return accelerator
    ? { "aria-keyshortcuts": acceleratorToAriaKeyShortcuts(accelerator) }
    : {};
}

/** Right-aligned content that is not a key hint, kept in the accessible name. */
export function MenuItemTrailing({
  children,
}: {
  readonly children: ReactNode;
}) {
  return (
    <span data-slot="menu-item-trailing" className={cn(asideBase, "ml-auto")}>
      {children}
    </span>
  );
}

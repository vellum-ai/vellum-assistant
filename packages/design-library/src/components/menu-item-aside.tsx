import { type ReactNode } from "react";

import { cn } from "../utils/cn";

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
  /**
   * Whether this element pushes itself to the right edge. False when a
   * trailing slot precedes it and has already taken the free space.
   */
  readonly push?: boolean;
  readonly children: ReactNode;
}

/**
 * Presentational key hint. Hidden from assistive tech, so the item itself
 * carries `aria-keyshortcuts` for the binding to be announced.
 */
export function MenuItemShortcut({
  push = true,
  children,
}: MenuItemShortcutProps) {
  return (
    <span
      data-slot="menu-item-shortcut"
      aria-hidden
      className={cn(asideBase, push && "ml-auto")}
    >
      {children}
    </span>
  );
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

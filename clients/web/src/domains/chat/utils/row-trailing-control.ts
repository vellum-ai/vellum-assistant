/**
 * The box a conversation row's trailing control draws in.
 *
 * A row has exactly one trailing affordance, and which one it is depends on
 * the `sidebar-done` flag: the actions ellipsis or the Done check. They stand
 * in the same cell, so nothing on the row may shift when one replaces the
 * other, which is what makes the geometry a shared constant rather than a
 * class list each control repeats.
 */

/** 24px on a pointer, 30px on a phone, quiet until the pointer is on it. */
export const ROW_TRAILING_CONTROL_CLASSES = [
  "flex h-6 w-6 items-center justify-center rounded-[4px]",
  "outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
  "text-[var(--content-tertiary)] transition-colors",
  "hover:bg-[var(--surface-hover)] hover:text-[var(--content-secondary)]",
  "aria-[expanded=true]:bg-[var(--surface-active)]",
  "aria-[expanded=true]:text-[var(--content-emphasised)]",
  "max-md:h-[30px] max-md:w-[30px]",
].join(" ");

/** The 14px glyph inside it, at the size a thumb needs on a phone. */
export const ROW_TRAILING_GLYPH_CLASSES = "max-md:h-[21px] max-md:w-[21px]";

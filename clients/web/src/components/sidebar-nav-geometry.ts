/**
 * Shared leading-chip geometry for expanded sidebar nav rows.
 *
 * The assistant cluster ({@link AssistantNavItem}: the New Chat plus and
 * the assistant eyes) and the collapsible section headers
 * ({@link CollapsibleNavSection}: Pinned, Chats, channels, groups) all
 * draw from these constants so their leading icons center on one axis
 * and their labels start at the same x — at every breakpoint. Adjust
 * them here, never per-component.
 */

/** Horizontal row padding before the leading chip. */
export const SIDEBAR_ROW_PADDING_X = 6;

/**
 * Width of the leading icon slot. Icons of any size center inside it,
 * so the axis holds whether the slot shows a 12px section icon, the
 * 14px plus, or the hand-tuned assistant eyes.
 */
export const SIDEBAR_CHIP_SIZE = 20;

/** Gap between the leading chip and the label. */
export const SIDEBAR_CHIP_GAP = 6;

/**
 * Left indent applied to a collapsible section's content, so its rows read as
 * children of the header rather than as a continuation of the flat list.
 *
 * Without it, a section header's label sits at
 * `SIDEBAR_ROW_PADDING_X + SIDEBAR_CHIP_SIZE + SIDEBAR_CHIP_GAP` (32px) while
 * its rows start at `SIDEBAR_ROW_PADDING_X` (6px), so the rows *outdent* past
 * their own header and section boundaries are hard to pick out.
 *
 * Deliberately a partial step rather than the full 26px that would align row
 * text under the header label: full alignment reads as a heading over a list
 * and costs real width on a 280px rail, where conversation titles are already
 * truncating. This nests the rows while leaving them close to the left edge.
 */
export const SIDEBAR_SECTION_INDENT = 12;

/**
 * Tallest a single section's row list grows before it scrolls within itself.
 *
 * Without a cap, one busy section pushes every section under it off the
 * screen, and the user has to collapse it to reach anything else. About nine
 * desktop rows (30px each plus their 4px gap), which is enough to read a
 * section as a list rather than a preview while still leaving room for its
 * neighbours.
 */
export const SIDEBAR_SECTION_MAX_HEIGHT = 300;

/**
 * Bounds for the Pinned section's user-adjustable height (dragging the rule
 * under the curated block). Min fits two desktop rows (30px each) plus their
 * 4px gap. Max stays a fixed constant rather than viewport-derived: the
 * sidebar body scrolls, so an oversized section degrades to body scrolling
 * the same way a long section list does today.
 */
export const SIDEBAR_SECTION_RESIZE_MIN_HEIGHT = 64;
export const SIDEBAR_SECTION_RESIZE_MAX_HEIGHT = 600;

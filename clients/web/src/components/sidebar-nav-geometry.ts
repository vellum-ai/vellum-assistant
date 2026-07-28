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

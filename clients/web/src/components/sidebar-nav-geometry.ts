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
export const SIDEBAR_ROW_PADDING_X = 12;

/**
 * Width of the leading icon slot. Icons of any size center inside it,
 * so the axis holds whether the slot shows a 12px section icon, the
 * 14px plus, or the hand-tuned assistant eyes.
 */
export const SIDEBAR_CHIP_SIZE = 20;

/** Gap between the leading chip and the label. */
export const SIDEBAR_CHIP_GAP = 6;

/**
 * Left indent applied to a collapsible section's content. Zero, so a
 * section's rows (e.g. Pinned's) start at the same x as flat-list rows
 * (e.g. Recents') instead of nesting under the header.
 */
export const SIDEBAR_SECTION_INDENT = 0;

/**
 * Tallest a non-last section's row list grows before it scrolls within
 * itself. Only the bottom-most section claims the sidebar's actual leftover
 * space (see `isLast` on `ConversationRowList`) - flex-grow has no notion of
 * "this section needs the room," so giving every open section a share
 * stretched a two-row group into a mostly-empty box the same size as a busy
 * one beside it. Every section above the last one gets this fixed cap
 * instead: about nine desktop rows (30px each plus their 4px gap), enough to
 * read as a list rather than a preview while still leaving room for its
 * neighbours.
 */
export const SIDEBAR_SECTION_MAX_HEIGHT = 300;

/**
 * The gap between any two stacked entries in the sidebar: the built-in nav's
 * pills, the section cards, and the scrollport that holds them.
 *
 * One constant rather than a `gap-*` at each container, because those
 * containers nest - the body holds the section root which holds the cards -
 * so a different value at any level surfaces as a different gap between two
 * adjacent entries, and which container wins is not locally visible.
 */
export const SIDEBAR_STACK_GAP = "gap-2";

/**
 * Text treatment for a section title (Pinned, a custom group, Chats, a
 * channel section). `font-[350]!` sits below
 * the `lighter` type-scale tier's own 400 weight, a step past the scale's
 * lightest named weight rather than a new tier of its own (DM Sans is a
 * variable font down to 300). The trailing `!` forces it over the
 * `text-body-*-lighter` utility's own font-weight: cross-package Tailwind
 * generation order doesn't reliably favor a plain (unmarked) override here.
 * Shared so every title reads at the same weight without drifting per call
 * site.
 */
export const SIDEBAR_SECTION_TITLE_TEXT_CLASSES =
  "text-left font-[350]! text-body-medium-lighter max-md:text-body-large-lighter text-[var(--content-tertiary)]";

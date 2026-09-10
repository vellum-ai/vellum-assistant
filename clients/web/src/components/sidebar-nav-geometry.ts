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
 * A section header's own leading inset on the rail (Figma 8300:167416): the
 * 8px a pill (`PanelItem`) keeps before its glyph, less the 1px transparent
 * border the section card draws inside the same column, so the header's
 * glyph stands on the same left edge as the New Chat plus and a pinned
 * app's icon above it. The trailing inset stays {@link SIDEBAR_ROW_PADDING_X}.
 */
export const SIDEBAR_HEADER_PADDING_X = 7;

/**
 * Width of the leading icon slot. Icons of any size center inside it,
 * so the axis holds whether the slot shows a 12px section icon, the
 * 14px plus, or the hand-tuned assistant eyes.
 */
export const SIDEBAR_CHIP_SIZE = 20;

/** Gap between the leading chip and the label. */
export const SIDEBAR_CHIP_GAP = 6;

/**
 * The assistant pill's leading disc (Figma 8300:167394): the solid circle
 * the eyes sit on. The section toggle beside the pill is drawn at the same
 * size, so the row reads as two discs of one family.
 */
export const SIDEBAR_ASSISTANT_DISC_SIZE = 32;

/**
 * {@link SIDEBAR_CHIP_GAP} as classes, with the touch-viewport value beside
 * it. A pill (`PanelItem`) sets 8px between its leading slot and its label,
 * and on a phone the section headers stand in the same column as the pills
 * at the same chip width, so they take the same 8px there: with it, a
 * header's label starts where the assistant row's and a pinned app's do.
 */
export const SIDEBAR_CHIP_GAP_CLASSES = "gap-[6px] max-md:gap-2";

/**
 * The leading chip on a touch viewport, as a class so a slot that is 14px
 * wide on a pointer viewport (a section header's) can grow on a phone. 24px
 * rather than {@link SIDEBAR_CHIP_SIZE}: the assistant row leads with a
 * 32px disc inset 2px and its label 6px after it (Figma 8300:167392), so its
 * label starts 40px in, and a row with 8px of padding and the pills' 8px gap
 * needs a 24px-wide chip to start its label there too. The 16px glyph in it
 * is the size `PanelItem` draws its own leading icon at there; centred in
 * the chip it sits 2px right of the eyes' centre, which the eye cannot see,
 * where a label 4px off the assistant's it can.
 */
export const SIDEBAR_MOBILE_CHIP_CLASSES = "max-md:h-5 max-md:w-6";
export const SIDEBAR_MOBILE_GLYPH_CLASSES = "max-md:size-4";

/**
 * A pinned app's leading slot at both breakpoints. On a pointer viewport it
 * hugs its 14px glyph, so the glyph starts on the pill's 8px inset, the
 * same edge the New Chat plus and a section header's glyph start on; on a
 * phone it is the chip.
 */
export const SIDEBAR_CHIP_CLASSES = `h-5 w-3.5 ${SIDEBAR_MOBILE_CHIP_CLASSES}`;

/**
 * The gap a pill that leads with a 14px glyph (New Chat, a pinned app,
 * Preferences) keeps before its label: 6px on the rail, so the label starts
 * 28px in like a section header's (8px inset, 14px glyph, 6px gap, Figma
 * 8300:167416); the pill's own 8px on a phone, where the chip is wider and
 * every label meets the assistant row's at 40px.
 */
export const SIDEBAR_PILL_GAP_CLASSES =
  "[--panel-item-gap:6px] max-md:[--panel-item-gap:8px]";
/* Only the width grows: a 24px-tall chip would stand a pinned pill 4px past
   the 44px overlay tile and a card's header row 4px past its 20px. */

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

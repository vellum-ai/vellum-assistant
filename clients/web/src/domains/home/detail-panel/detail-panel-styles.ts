/**
 * Styling shared by the notification detail cards.
 *
 * Extracted so two cards cannot drift into two slightly different recessed
 * blocks: the reader sees them in the same panel, one after another, and a
 * difference in radius or tone reads as a difference in meaning.
 */

/** Prose set in a recessed block, so it reads as the quoted thing. */
export const SUMMARY_BLOCK_CLASS = [
  "rounded-[var(--radius-md)] bg-[var(--surface-sunken)]",
  "p-[var(--app-spacing-md)] leading-normal text-[var(--content-secondary)]",
].join(" ");

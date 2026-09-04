import { forwardRef } from "react";

import { cn } from "@/utils/misc";

import { Button } from "@vellumai/design-library";

/**
 * Suggestion-pill primitive used in the chat empty state's bottom dock and by
 * the activation checklist's expanded task row
 * (Figma: New-App 7471-25035). Wraps the `Button` primitive
 * (`variant="ghost"`, `fullWidth`) so interactive surface tokens stay
 * owned by `Button`. Overrides cover layout only: Button's default
 * `h-8` / `whitespace-nowrap` is swapped for a soft white rounded card
 * via tailwind-merge.
 */

/**
 * Which box the chip draws.
 *
 * `dock` is the full-width card the chat empty state's bottom dock lays out in
 * a grid. `compact` is a pill that hugs its words, which is what the activation
 * checklist's expanded row wants beside a description.
 *
 * A variant rather than a `className` override: the box states its size floor
 * at two breakpoints, and tailwind-merge resolves a conflict per variant
 * prefix, so an override that drops the floor drops only the unprefixed half
 * and the `sm:` one still applies from 640px up.
 */
export type ConversationStarterChipVariant = "dock" | "compact";

export interface ConversationStarterChipProps {
  /** Suggestion text. Truncated to two lines via `line-clamp-2`. */
  label: string;
  /** Invoked when the chip is clicked (and not disabled). */
  onSelect: () => void;
  variant?: ConversationStarterChipVariant;
  disabled?: boolean;
  /**
   * Optional override for the chip's accessible name. When omitted, screen
   * readers fall back to the visible `label` text.
   */
  "aria-label"?: string;
  /**
   * Merged last, so a surface can restate the chip's box: the activation
   * checklist's row wants a hugging tinted pill rather than the dock's
   * full-width card.
   */
  className?: string;
}

/**
 * The chip's box: its size floor, border, insets, corner, and type. Shared
 * with the dock's reserved placeholder so the space held for a chip and the
 * chip that lands in it are measured from the same classes.
 *
 * The border is stated here rather than left to `Button`, which sets a 1px
 * one on its base and paints it transparent for `ghost`. A chip taller than
 * its size floor (the two-line case the dock reserves for) is content plus
 * padding plus that border, so a placeholder without it comes up 2px short
 * per chip and the arriving chips push the dock open.
 */
export const CONVERSATION_STARTER_CHIP_BOX =
  "h-auto min-h-[40px] sm:min-h-[44px] border border-transparent px-3 py-2 sm:px-4 sm:py-2.5 rounded-[12px] text-body-small-lighter sm:text-body-medium-lighter";

/**
 * The hugging pill: no size floor at either breakpoint, tighter insets, and
 * the pill corner. Stated in full rather than layered over
 * {@link CONVERSATION_STARTER_CHIP_BOX} so the two breakpoints cannot
 * disagree.
 */
const CONVERSATION_STARTER_CHIP_COMPACT_BOX =
  "h-auto min-h-0 w-auto border border-transparent px-1.5 py-1 rounded-[var(--radius-pill)] text-label-medium-default";

/**
 * The label's line box. The body-type tokens pin `line-height` to 18px, which
 * is tighter than the glyphs need: `line-clamp`'s overflow clipping cuts
 * descenders (the "g" in "morning") without real line height. Shared with the
 * dock's reserved placeholder for the same reason as
 * {@link CONVERSATION_STARTER_CHIP_BOX}: two reserved lines and two rendered
 * lines have to measure the same.
 */
export const CONVERSATION_STARTER_CHIP_LINE = "leading-normal";

export const ConversationStarterChip = forwardRef<
  HTMLButtonElement,
  ConversationStarterChipProps
>(function ConversationStarterChip(
  {
    label,
    onSelect,
    variant = "dock",
    disabled,
    "aria-label": ariaLabel,
    className,
  },
  ref,
) {
  return (
    <Button
      ref={ref}
      variant="ghost"
      fullWidth
      disabled={disabled}
      onClick={onSelect}
      aria-label={ariaLabel}
      className={cn(
        // Override Button's single-line default.
        "whitespace-normal",
        // The box overrides Button's fixed height and default body size, and
        // themes the type in the secondary tone: reads like the app's buttons
        // rather than heavy title text.
        variant === "compact"
          ? CONVERSATION_STARTER_CHIP_COMPACT_BOX
          : CONVERSATION_STARTER_CHIP_BOX,
        "text-center",
        // Soft white card, no border (Figma 7471-25047).
        "bg-[var(--surface-lift)] [--vbtn-fg:var(--content-secondary)]",
        className,
      )}
    >
      <span className={`line-clamp-2 ${CONVERSATION_STARTER_CHIP_LINE}`}>
        {label}
      </span>
    </Button>
  );
});

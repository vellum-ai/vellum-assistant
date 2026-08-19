import { forwardRef } from "react";

import { cn } from "@/utils/misc";

import { Button } from "@vellumai/design-library";

/**
 * Suggestion-pill primitive used in the chat empty state's bottom dock
 * (Figma: New-App 7471-25035). Wraps the `Button` primitive
 * (`variant="ghost"`, `fullWidth`) so interactive surface tokens stay
 * owned by `Button`. Overrides cover layout only — Button's default
 * `h-8` / `whitespace-nowrap` is swapped for a soft white rounded card
 * via tailwind-merge.
 */
export interface ConversationStarterChipProps {
  /** Suggestion text. Truncated to two lines via `line-clamp-2`. */
  label: string;
  /** Invoked when the chip is clicked (and not disabled). */
  onSelect: () => void;
  disabled?: boolean;
  /**
   * Optional override for the chip's accessible name. When omitted, screen
   * readers fall back to the visible `label` text.
   */
  "aria-label"?: string;
}

/**
 * The chip's box: its size floor, insets, corner, and type. Shared with the
 * dock's reserved placeholder so the space held for a chip and the chip that
 * lands in it are measured from the same classes.
 */
export const CONVERSATION_STARTER_CHIP_BOX =
  "min-h-[40px] sm:min-h-[44px] px-3 py-2 sm:px-4 sm:py-2.5 rounded-[12px] text-body-small-lighter sm:text-body-medium-lighter";

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
  { label, onSelect, disabled, "aria-label": ariaLabel },
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
        // Override Button's fixed h-8 / single-line / default body size.
        "h-auto whitespace-normal",
        // Theme body type in the secondary tone: reads like the app's
        // buttons rather than heavy title text.
        CONVERSATION_STARTER_CHIP_BOX,
        "text-center",
        // Soft white card, no border (Figma 7471-25047).
        "bg-[var(--surface-lift)] [--vbtn-fg:var(--content-secondary)]",
      )}
    >
      <span className={`line-clamp-2 ${CONVERSATION_STARTER_CHIP_LINE}`}>
        {label}
      </span>
    </Button>
  );
});

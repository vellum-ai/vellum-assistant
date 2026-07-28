
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
        "min-h-[44px] sm:min-h-[52px]",
        "px-3 py-2.5 sm:px-4 sm:py-3 rounded-[16px]",
        "text-body-small-default sm:text-title-small text-center",
        // Soft white card, no border (Figma 7471-25047).
        "bg-[var(--surface-lift)] [--vbtn-fg:var(--content-default)]",
      )}
    >
      {/* leading-normal: the title-small token is line-height:1, and
          line-clamp's overflow clipping would cut descenders (the "g" in
          "morning") without real line height. */}
      <span className="line-clamp-2 leading-normal">{label}</span>
    </Button>
  );
});


import { forwardRef } from "react";

import { cn } from "@/utils/misc";

import { Button } from "@vellumai/design-library";

/**
 * Suggestion-pill primitive used in the chat empty state. Wraps the `Button`
 * primitive (`variant="outlined"`, `fullWidth`) so interactive surface
 * tokens stay owned by `Button`. Overrides cover layout only — Button's
 * default `h-8` / `whitespace-nowrap` / `body-medium-default` are swapped
 * for a 56px-min, two-line-clamped, `body-medium-lighter` card via
 * tailwind-merge.
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
        // Slimmer + smaller text on mobile, full size on sm+.
        "px-3 py-2 sm:px-4 sm:py-3 rounded-[10px]",
        "text-body-small-default sm:text-body-medium-lighter text-center",
        // Light fill, no border, secondary content text.
        "bg-[var(--surface-lift)] [--vbtn-fg:var(--content-secondary)]",
      )}
    >
      <span className="line-clamp-2">{label}</span>
    </Button>
  );
});

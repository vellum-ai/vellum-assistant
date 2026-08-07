/**
 * The collapsed select-style trigger shared by the speech pickers: the
 * current value plus a chevron, mirroring the design-library Select
 * trigger's field styling so a picker field reads as a sibling of a real
 * Select while opening a popover or dialog instead.
 *
 * Sites: the Text-to-Speech card's voice field (`VoicePickerField`, inside a
 * `Popover.Trigger asChild`, which injects its open/close wiring through the
 * spread props and ref), the Speech-to-Text form's spoken-language field, and
 * the voice first-run card's compact listening-language row. Per-site chrome
 * (the first-run row's leading icon, labels, helper text) stays at the call
 * sites by composition.
 */

import { type ComponentProps } from "react";

import { ChevronDown } from "lucide-react";

import { cn } from "@vellumai/design-library";

export interface SelectTriggerRowProps extends ComponentProps<"button"> {
  /** Display text for the current value. */
  value: string;
  /**
   * `default` is the full-width h-9 form field; `compact` is the h-7 inline
   * row the first-run card uses beside its label.
   */
  size?: "default" | "compact";
}

export function SelectTriggerRow({
  value,
  size = "default",
  className,
  ...props
}: SelectTriggerRowProps) {
  const compact = size === "compact";
  return (
    <button
      type="button"
      className={cn(
        "flex items-center gap-2 rounded-md border border-[var(--field-border)] bg-[var(--field-bg)] text-left text-[var(--content-default)] transition-colors focus:outline-none data-[state=open]:border-[var(--border-active)]",
        compact
          ? "h-7 min-w-44 px-2.5 text-body-small-default"
          : "h-9 w-full px-3 text-body-medium-lighter",
        className,
      )}
      {...props}
    >
      <span className="min-w-0 flex-1 truncate">{value}</span>
      <ChevronDown
        aria-hidden
        className={cn(
          "shrink-0 text-[var(--content-tertiary)]",
          compact ? "h-3 w-3" : "h-3.5 w-3.5",
        )}
      />
    </button>
  );
}

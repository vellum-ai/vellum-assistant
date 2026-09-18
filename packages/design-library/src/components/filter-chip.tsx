import type { ComponentProps, ReactNode } from "react";

import { cn } from "../utils/cn";

export interface FilterChipProps extends Omit<
  ComponentProps<"button">,
  "children"
> {
  /** Whether the chip's filter is applied. Exposed as `aria-pressed`. */
  selected: boolean;
  /**
   * How many items the filter would leave, drawn lighter than the label so
   * the label stays what the chip reads as.
   */
  count?: number;
  children: ReactNode;
}

/**
 * A toggle pill for narrowing a list, sized to sit in a row under a search
 * field. Selection is the caller's: the chip reports clicks and draws the
 * `selected` it is given, so a row of them can be single- or multi-select
 * without the chip knowing which.
 */
export function FilterChip({
  selected,
  count,
  className,
  children,
  type = "button",
  ...props
}: FilterChipProps) {
  return (
    <button
      data-slot="filter-chip"
      type={type}
      aria-pressed={selected}
      className={cn(
        "inline-flex h-8 shrink-0 select-none items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-body-medium-default transition-colors",
        "keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)] keyboard-focus:ring-offset-0 focus-visible:outline-none",
        "disabled:cursor-not-allowed disabled:opacity-50",
        selected
          ? "border-transparent bg-[var(--primary-base)] text-[var(--content-inset)]"
          : "border-[var(--border-subtle)] bg-[var(--surface-lift)] text-[var(--content-secondary)] hover:border-[var(--border-hover)] hover:text-[var(--content-default)]",
        className,
      )}
      {...props}
    >
      <span data-slot="filter-chip-label">{children}</span>
      {count !== undefined ? (
        <span
          data-slot="filter-chip-count"
          className={cn(
            "text-body-small-lighter tabular-nums",
            selected ? "opacity-70" : "text-[var(--content-tertiary)]",
          )}
        >
          {count}
        </span>
      ) : null}
    </button>
  );
}

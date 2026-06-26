import { Check } from "lucide-react";

import { cn } from "@/utils/misc";

interface SelectionIndicatorProps {
  selected: boolean;
  /** Single-select renders a circle (radio); multi-select renders a square. */
  single: boolean;
}

/**
 * Checkbox/radio-style selection indicator for selectable list and table rows:
 * a rounded square (multi-select) or circle (single-select) that fills with the
 * primary color and shows a check when selected.
 */
export function SelectionIndicator({ selected, single }: SelectionIndicatorProps) {
  return (
    <span
      className={cn(
        "flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors",
        selected
          ? "border-[var(--primary-base)] bg-[var(--primary-base)] text-[var(--content-inset)]"
          : "border-[var(--border-element)]",
        single ? "rounded-full" : "rounded",
      )}
    >
      {selected && <Check className="h-3 w-3" />}
    </span>
  );
}

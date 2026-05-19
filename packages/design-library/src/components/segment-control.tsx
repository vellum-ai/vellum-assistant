import { type ReactNode } from "react";

import { Button } from "./button.js";
import { cn } from "../utils/cn.js";

export interface SegmentControlItem<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
}

export interface SegmentControlProps<T extends string> {
  items: SegmentControlItem<T>[];
  value: T;
  onChange: (next: T) => void;
  ariaLabel?: string;
  /**
   * When true, each segment renders only its `icon` and uses `label` as the
   * button's `aria-label`.
   */
  iconOnly?: boolean;
  className?: string;
}

/**
 * Pure selection helper verifiable in tests without a DOM environment.
 * Returns the next value, or `null` when the click is a no-op (same-value
 * click or click on a disabled segment).
 */
export function resolveSegmentSelection<T extends string>(
  items: SegmentControlItem<T>[],
  currentValue: T,
  clickedValue: T,
): T | null {
  const item = items.find((candidate) => candidate.value === clickedValue);
  if (!item) return null;
  if (item.disabled) return null;
  if (item.value === currentValue) return null;
  return item.value;
}

export function SegmentControl<T extends string>({
  items,
  value,
  onChange,
  ariaLabel,
  iconOnly = false,
  className,
}: SegmentControlProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      data-slot="segment-control"
      className={cn(
        "inline-flex rounded-lg bg-[var(--surface-active)] p-0.5",
        !iconOnly && "w-full",
        className,
      )}
    >
      {items.map((item) => {
        const isActive = item.value === value;
        const isDisabled = Boolean(item.disabled);
        return (
          <Button
            key={item.value}
            variant="ghost"
            role="radio"
            aria-checked={isActive}
            aria-label={iconOnly ? item.label : undefined}
            disabled={isDisabled}
            onClick={() => {
              const next = resolveSegmentSelection(items, value, item.value);
              if (next !== null) {
                onChange(next);
              }
            }}
            className={cn(
              "min-w-[30px] cursor-pointer justify-center gap-1.5 rounded-md border-0 text-body-medium-default",
              iconOnly
                ? "h-7 px-[5px] py-1 max-md:h-9 max-md:min-w-9 max-md:px-2"
                : "h-auto flex-1 px-3 py-1.5",
              isActive
                ? "bg-[var(--surface-overlay)] text-[var(--content-emphasised)] shadow-sm hover:bg-[var(--surface-overlay)]"
                : "bg-transparent text-[var(--content-tertiary)] hover:bg-transparent hover:text-[var(--content-emphasised)]",
            )}
          >
            {item.icon}
            {!iconOnly && item.label}
          </Button>
        );
      })}
    </div>
  );
}

import { type KeyboardEvent, type ReactNode, useCallback, useRef } from "react";

import { Button } from "./button";
import { cn } from "../utils/cn";

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

/**
 * Finds the next enabled item index in the given direction, wrapping around.
 */
function findEnabledIndex<T extends string>(
  items: SegmentControlItem<T>[],
  fromIndex: number,
  direction: 1 | -1,
): number {
  const len = items.length;
  let idx = (fromIndex + direction + len) % len;
  let attempts = 0;
  while (items[idx]?.disabled && attempts < len) {
    idx = (idx + direction + len) % len;
    attempts++;
  }
  return idx;
}

export function SegmentControl<T extends string>({
  items,
  value,
  onChange,
  ariaLabel,
  iconOnly = false,
  className,
}: SegmentControlProps<T>) {
  const groupRef = useRef<HTMLDivElement>(null);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const currentIndex = items.findIndex((item) => item.value === value);
      if (currentIndex === -1) return;

      let nextIndex: number | null = null;

      switch (event.key) {
        case "ArrowRight":
        case "ArrowDown":
          nextIndex = findEnabledIndex(items, currentIndex, 1);
          break;
        case "ArrowLeft":
        case "ArrowUp":
          nextIndex = findEnabledIndex(items, currentIndex, -1);
          break;
        case "Home":
          nextIndex = findEnabledIndex(items, items.length - 1, 1);
          break;
        case "End":
          nextIndex = findEnabledIndex(items, 0, -1);
          break;
        default:
          return;
      }

      event.preventDefault();
      const nextItem = items[nextIndex];
      if (!nextItem || nextItem.disabled) return;

      if (nextItem.value !== value) {
        onChange(nextItem.value);
      }

      const buttons = groupRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="radio"]',
      );
      buttons?.[nextIndex]?.focus();
    },
    [items, value, onChange],
  );

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label={ariaLabel}
      data-slot="segment-control"
      onKeyDown={handleKeyDown}
      className={cn(
        "inline-flex bg-[var(--surface-active)] p-0.5",
        iconOnly ? "rounded-[10px]" : "w-full rounded-lg",
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
            tabIndex={isActive ? 0 : -1}
            onClick={() => {
              const next = resolveSegmentSelection(items, value, item.value);
              if (next !== null) {
                onChange(next);
              }
            }}
            className={cn(
              "min-w-[30px] cursor-pointer justify-center gap-1.5 border-0 text-body-medium-default",
              // Icon-only (theme switcher): matches Figma 4502:120659 — 10px
              // track radius, 8px segment radius, 8px horizontal padding, and a
              // taller active pill (36px) than the inactive segments (28px).
              iconOnly && "min-w-9 rounded-lg px-2",
              iconOnly && (isActive ? "h-9" : "h-7 max-md:h-9"),
              !iconOnly && "h-auto flex-1 rounded-md px-3 py-1.5",
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

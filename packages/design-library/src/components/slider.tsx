import * as SliderPrimitive from "@radix-ui/react-slider";
import { type ReactNode, useId } from "react";

import { cn } from "../utils/cn";

export type SliderValue = number | [number, number];

export function isRangeValue(value: SliderValue): value is [number, number] {
  return Array.isArray(value);
}

export function toValueArray(value: SliderValue): number[] {
  return isRangeValue(value) ? [value[0], value[1]] : [value];
}

export function fromValueArray(
  next: number[],
  isRange: boolean,
  min: number,
  max: number,
): SliderValue {
  if (isRange) {
    return [next[0] ?? min, next[1] ?? max];
  }
  return next[0] ?? min;
}

export function formatDisplayValue(value: SliderValue): string {
  if (isRangeValue(value)) {
    return `${value[0]} – ${value[1]}`;
  }
  return String(value);
}

export interface SliderProps {
  value: SliderValue;
  onValueChange: (next: SliderValue) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  label?: ReactNode;
  showValue?: boolean;
  formatValue?: (value: SliderValue) => string;
  name?: string;
  id?: string;
  "aria-label"?: string;
  className?: string;
}

export function Slider({
  value,
  onValueChange,
  min = 0,
  max = 100,
  step = 1,
  disabled = false,
  label,
  showValue = false,
  formatValue,
  name,
  id,
  "aria-label": ariaLabel,
  className,
}: SliderProps) {
  const reactId = useId();
  const resolvedId = id ?? reactId;
  const labelId = label ? `${resolvedId}-label` : undefined;

  const isRange = isRangeValue(value);
  const valueArray = toValueArray(value);

  const handleValueChange = (next: number[]) => {
    onValueChange(fromValueArray(next, isRange, min, max));
  };

  const displayValue = formatValue
    ? formatValue(value)
    : formatDisplayValue(value);

  const thumbClasses = cn(
    "block h-4 w-4 rounded-full bg-[var(--aux-white)]",
    "border-2 border-[var(--system-positive-strong)]",
    "shadow-sm transition-colors",
    "keyboard-focus:outline-none keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)] keyboard-focus:ring-offset-0",
    disabled
      ? "cursor-not-allowed border-[var(--border-disabled)]"
      : "cursor-grab active:cursor-grabbing",
  );

  return (
    <div data-slot="slider" className={cn("flex flex-col gap-1.5", className)}>
      {(label || showValue) && (
        <div className="flex items-center justify-between gap-3">
          {label ? (
            <span
              id={labelId}
              className={cn(
                "text-body-medium-default",
                disabled
                  ? "text-[var(--content-disabled)]"
                  : "text-[var(--content-default)]",
              )}
            >
              {label}
            </span>
          ) : (
            <span />
          )}
          {showValue ? (
            <span
              className={cn(
                "text-body-medium-lighter tabular-nums",
                disabled
                  ? "text-[var(--content-disabled)]"
                  : "text-[var(--content-secondary)]",
              )}
            >
              {displayValue}
            </span>
          ) : null}
        </div>
      )}
      <SliderPrimitive.Root
        id={resolvedId}
        name={name}
        value={valueArray}
        onValueChange={handleValueChange}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        aria-label={!label ? ariaLabel : undefined}
        aria-labelledby={label ? labelId : undefined}
        className={cn(
          "relative flex w-full touch-none items-center select-none",
          "h-5",
          disabled && "opacity-60",
        )}
      >
        <SliderPrimitive.Track
          className={cn(
            "relative h-1 w-full grow overflow-hidden rounded-full",
            "bg-[var(--border-disabled)]",
          )}
        >
          <SliderPrimitive.Range
            className={cn(
              "absolute h-full rounded-full",
              disabled
                ? "bg-[var(--border-element)]"
                : "bg-[var(--system-positive-strong)]",
            )}
          />
        </SliderPrimitive.Track>
        <SliderPrimitive.Thumb className={thumbClasses} />
        {isRange ? <SliderPrimitive.Thumb className={thumbClasses} /> : null}
      </SliderPrimitive.Root>
    </div>
  );
}

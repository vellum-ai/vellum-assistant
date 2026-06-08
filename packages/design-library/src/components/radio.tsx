import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { type CSSProperties, type ReactNode, useId } from "react";

import { Typography } from "./typography";
import { cn } from "../utils/cn";

export interface RadioGroupProps<T extends string> {
  readonly value: T;
  readonly onValueChange: (value: T) => void;
  readonly name?: string;
  readonly disabled?: boolean;
  readonly orientation?: "vertical" | "horizontal";
  readonly required?: boolean;
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly children: ReactNode;
  readonly "aria-label"?: string;
  readonly "aria-labelledby"?: string;
}

/**
 * Single-select radio group wrapping `@radix-ui/react-radio-group`.
 * Preserves Radix's roving tabindex / arrow-key navigation and
 * `aria-checked` semantics. Generic over `T extends string` so callers
 * can narrow the value type.
 */
function RadioGroup<T extends string>({
  value,
  onValueChange,
  name,
  disabled,
  orientation = "vertical",
  required,
  className,
  style,
  children,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
}: RadioGroupProps<T>) {
  const layoutClass =
    orientation === "horizontal"
      ? "flex flex-row flex-wrap items-center gap-4"
      : "flex flex-col gap-2.5";

  return (
    <RadioGroupPrimitive.Root
      value={value}
      onValueChange={(next) => onValueChange(next as T)}
      name={name}
      disabled={disabled}
      required={required}
      orientation={orientation}
      className={cn(layoutClass, className)}
      style={style}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      data-slot="radio-group"
    >
      {children}
    </RadioGroupPrimitive.Root>
  );
}

export interface RadioProps<T extends string> {
  readonly value: T;
  readonly label?: ReactNode;
  readonly helperText?: ReactNode;
  readonly disabled?: boolean;
  readonly id?: string;
  readonly className?: string;
  readonly "aria-label"?: string;
}

/**
 * Single radio option for use inside a `RadioGroup`. Outer ring is 16×16
 * with an 8×8 inner dot when selected.
 */
function Radio<T extends string>({
  value,
  label,
  helperText,
  disabled,
  id,
  className,
  "aria-label": ariaLabel,
}: RadioProps<T>) {
  const reactId = useId();
  const inputId = id ?? `radio-${reactId}`;
  const helperId = helperText ? `${inputId}-helper` : undefined;

  const ringSelectedColor = disabled
    ? "var(--content-disabled)"
    : "var(--system-positive-strong)";
  const ringBg = disabled ? "var(--surface-overlay)" : "transparent";

  return (
    <div
      data-slot="radio"
      className={cn(
        "flex gap-2",
        helperText ? "items-start" : "items-center",
        className,
      )}
    >
      <RadioGroupPrimitive.Item
        id={inputId}
        value={value}
        disabled={disabled}
        aria-label={!label ? ariaLabel : undefined}
        aria-describedby={helperId}
        className={cn(
          "relative inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors",
          "border-[color:var(--radio-border)]",
          "[--radio-border:var(--border-element)]",
          "data-[state=checked]:border-transparent",
          "disabled:[--radio-border:var(--content-disabled)]",
          "disabled:cursor-not-allowed",
          "keyboard-focus:outline-none keyboard-focus:ring-2 keyboard-focus:ring-offset-1",
          "keyboard-focus:ring-[color-mix(in_srgb,var(--system-positive-strong)_30%,transparent)]",
        )}
        style={{ background: ringBg }}
      >
        <RadioGroupPrimitive.Indicator
          forceMount
          className="flex h-full w-full items-center justify-center rounded-full data-[state=unchecked]:opacity-0"
          style={{ background: ringSelectedColor }}
        >
          <span
            aria-hidden
            className="block h-2 w-2 rounded-full"
            style={{
              background: disabled
                ? "var(--surface-overlay)"
                : "var(--aux-white)",
            }}
          />
        </RadioGroupPrimitive.Indicator>
      </RadioGroupPrimitive.Item>
      {(label || helperText) && (
        <div className="flex min-w-0 flex-col gap-0.5">
          {label ? (
            <Typography
              as="label"
              variant="body-medium-lighter"
              htmlFor={inputId}
              className={cn(
                disabled ? "cursor-not-allowed" : "cursor-pointer",
                disabled
                  ? "text-[color:var(--content-disabled)]"
                  : "text-[color:var(--content-default)]",
              )}
            >
              {label}
            </Typography>
          ) : null}
          {helperText ? (
            <Typography
              as="span"
              variant="body-small-default"
              id={helperId}
              className={cn(
                "leading-4",
                disabled
                  ? "text-[color:var(--content-disabled)]"
                  : "text-[color:var(--content-tertiary)]",
              )}
            >
              {helperText}
            </Typography>
          ) : null}
        </div>
      )}
    </div>
  );
}

export { RadioGroup, Radio };

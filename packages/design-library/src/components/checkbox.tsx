import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check, Minus } from "lucide-react";
import { type ComponentProps, type ReactNode, useId } from "react";

import { Typography } from "./typography";
import { cn } from "../utils/cn";

export type CheckboxState = boolean | "indeterminate";

export interface CheckboxProps
  extends Omit<ComponentProps<typeof CheckboxPrimitive.Root>, "checked" | "onCheckedChange"> {
  checked: CheckboxState;
  onCheckedChange?: (checked: CheckboxState) => void;
  label?: ReactNode;
  helperText?: ReactNode;
  "aria-label"?: string;
}

/**
 * Checkbox wrapping `@radix-ui/react-checkbox`. Inherits keyboard handling,
 * focus management, and a11y attributes (`aria-checked`, `data-state`).
 *
 * - Pass `checked` / `onCheckedChange` for controlled use.
 * - Pass `"indeterminate"` as `checked` to render the tri-state dash.
 * - Pass `label` for a clickable label, `helperText` for secondary copy.
 */
function Checkbox({
  checked,
  onCheckedChange,
  label,
  helperText,
  disabled = false,
  id,
  name,
  className,
  ref,
  "aria-label": ariaLabel,
  ...rest
}: CheckboxProps) {
  const reactId = useId();
  const resolvedId = id ?? reactId;
  const labelId = label ? `${resolvedId}-label` : undefined;
  const helperTextId = helperText ? `${resolvedId}-helper` : undefined;

  const isIndeterminate = checked === "indeterminate";

  const rootClasses = cn(
    "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px]",
    "border transition-colors outline-none cursor-pointer",
    "keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)] keyboard-focus:ring-offset-0",
    "bg-[var(--surface-lift)] border-[var(--border-base)]",
    "data-[state=checked]:bg-[var(--system-positive-strong)] data-[state=checked]:border-transparent",
    "data-[state=indeterminate]:bg-[var(--system-positive-strong)] data-[state=indeterminate]:border-transparent",
    "disabled:cursor-not-allowed disabled:bg-[var(--surface-overlay)]",
    "disabled:data-[state=checked]:bg-[var(--surface-overlay)]",
    "disabled:data-[state=indeterminate]:bg-[var(--surface-overlay)]",
    "disabled:border-[var(--border-base)]",
  );

  const iconClasses = cn(
    "h-3 w-3",
    disabled
      ? "text-[color:var(--content-disabled)]"
      : "text-[color:var(--aux-white)]",
  );

  const checkbox = (
    <CheckboxPrimitive.Root
      {...rest}
      ref={ref}
      id={resolvedId}
      name={name}
      checked={checked}
      disabled={disabled}
      onCheckedChange={onCheckedChange}
      aria-label={!label ? ariaLabel : undefined}
      aria-labelledby={label ? labelId : undefined}
      aria-describedby={helperTextId}
      data-slot="checkbox"
      className={rootClasses}
    >
      <CheckboxPrimitive.Indicator
        forceMount
        className="flex items-center justify-center"
      >
        {isIndeterminate ? (
          <Minus className={iconClasses} strokeWidth={3} aria-hidden="true" />
        ) : checked === true ? (
          <Check className={iconClasses} strokeWidth={3} aria-hidden="true" />
        ) : null}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );

  if (!label && !helperText) {
    return <span data-slot="checkbox" className={className}>{checkbox}</span>;
  }

  return (
    <div
      data-slot="checkbox"
      className={cn(
        "flex gap-2.5",
        helperText ? "items-start" : "items-center",
        className,
      )}
    >
      {checkbox}
      <div className="flex min-w-0 flex-col gap-0.5">
        {label ? (
          <Typography
            as="label"
            variant="body-medium-default"
            id={labelId}
            htmlFor={resolvedId}
            className={cn(
              "cursor-pointer select-none",
              disabled
                ? "cursor-not-allowed text-[color:var(--content-disabled)]"
                : "text-[color:var(--content-default)]",
            )}
          >
            {label}
          </Typography>
        ) : null}
        {helperText ? (
          <span
            id={helperTextId}
            className="text-body-small-default text-[color:var(--content-secondary)]"
          >
            {helperText}
          </span>
        ) : null}
      </div>
    </div>
  );
}

export { Checkbox };

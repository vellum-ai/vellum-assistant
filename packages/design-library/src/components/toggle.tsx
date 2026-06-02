import { type ReactNode, useId } from "react";

import { Typography } from "./typography";
import { cn } from "../utils/cn";

export interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: ReactNode;
  helperText?: ReactNode;
  disabled?: boolean;
  id?: string;
  "aria-label"?: string;
  className?: string;
}

/**
 * Pure click-handler contract used by the `<button>` and verifiable in tests
 * without a DOM environment.
 */
export function handleToggleClick(
  checked: boolean,
  disabled: boolean,
  onChange: (next: boolean) => void,
): void {
  if (disabled) return;
  onChange(!checked);
}

/**
 * On/off toggle switch. Track is 36×24 px with a 20×20 px knob offset 2 px
 * from the edges. Uses CSS variable tokens for light/dark theming.
 */
export function Toggle({
  checked,
  onChange,
  label,
  helperText,
  disabled = false,
  id,
  "aria-label": ariaLabel,
  className,
}: ToggleProps) {
  const reactId = useId();
  const buttonId = id ?? reactId;
  const labelId = label ? `${buttonId}-label` : undefined;
  const helperTextId = helperText ? `${buttonId}-helper` : undefined;

  const toggle = () => handleToggleClick(checked, disabled, onChange);

  const trackClasses = cn(
    "relative inline-flex h-6 w-9 shrink-0 items-center rounded-full transition-colors",
    "keyboard-focus:outline-none keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)] keyboard-focus:ring-offset-2",
    disabled
      ? "cursor-not-allowed bg-[var(--primary-disabled)]"
      : checked
        ? "cursor-pointer bg-[var(--system-positive-strong)]"
        : "cursor-pointer bg-[var(--surface-active)]",
  );

  const knobClasses = cn(
    "absolute top-0.5 inline-block h-5 w-5 rounded-full shadow transition-transform",
    disabled ? "bg-[var(--content-disabled)]" : "bg-[var(--aux-white)]",
    checked ? "left-0.5 translate-x-3" : "left-0.5 translate-x-0",
  );

  const toggleButton = (
    <button
      type="button"
      role="switch"
      id={buttonId}
      aria-checked={checked}
      aria-label={!label ? ariaLabel : undefined}
      aria-labelledby={label ? labelId : undefined}
      aria-describedby={helperTextId}
      disabled={disabled}
      onClick={toggle}
      data-slot="toggle"
      className={trackClasses}
    >
      <span className={knobClasses} />
    </button>
  );

  if (!label && !helperText) {
    return <span data-slot="toggle" className={className}>{toggleButton}</span>;
  }

  return (
    <div
      data-slot="toggle"
      className={cn(
        "flex gap-2.5",
        helperText ? "items-start" : "items-center",
        className,
      )}
    >
      {toggleButton}
      <div className="flex min-w-0 flex-col gap-0.5">
        {label ? (
          <Typography
            as="label"
            variant="body-medium-default"
            id={labelId}
            htmlFor={buttonId}
            className={cn(
              disabled
                ? "cursor-not-allowed text-[var(--content-disabled)]"
                : "cursor-pointer text-[var(--content-default)]",
            )}
          >
            {label}
          </Typography>
        ) : null}
        {helperText ? (
          <span
            id={helperTextId}
            className="text-body-small-default text-[var(--content-tertiary)]"
          >
            {helperText}
          </span>
        ) : null}
      </div>
    </div>
  );
}

import { type ReactNode, useId } from "react";

import { Typography } from "./typography";
import { cn } from "../utils/cn";

export type ToggleSize = "md" | "sm";

export interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: ReactNode;
  helperText?: ReactNode;
  disabled?: boolean;
  id?: string;
  "aria-label"?: string;
  className?: string;
  /**
   * Track height. `md` (24px) is the page-level default; `sm` (16px) suits
   * dense contexts such as a row inside a sidepanel's details card.
   */
  size?: ToggleSize;
}

/**
 * Per-size geometry. The knob insets 2px on every edge, so the checked
 * offset is always `track width − knob − 2×inset`: 36−20−4=12 at `md`,
 * 24−12−4=8 at `sm`.
 */
const SIZES: Record<
  ToggleSize,
  { track: string; knob: string; translate: string }
> = {
  md: { track: "h-6 w-9", knob: "h-5 w-5", translate: "translate-x-3" },
  sm: { track: "h-4 w-6", knob: "h-3 w-3", translate: "translate-x-2" },
};

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
 * On/off toggle switch. Two sizes, both with the knob inset 2 px from the
 * track edges: `md` is a 36×24 px track with a 20 px knob, `sm` a 24×16 px
 * track with a 12 px knob. Uses CSS variable tokens for light/dark theming.
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
  size = "md",
}: ToggleProps) {
  const reactId = useId();
  const buttonId = id ?? reactId;
  const labelId = label ? `${buttonId}-label` : undefined;
  const helperTextId = helperText ? `${buttonId}-helper` : undefined;

  const toggle = () => handleToggleClick(checked, disabled, onChange);

  const geometry = SIZES[size];

  const trackClasses = cn(
    "relative inline-flex shrink-0 items-center rounded-full transition-colors",
    geometry.track,
    "keyboard-focus:outline-none keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)] keyboard-focus:ring-offset-2",
    disabled
      ? "cursor-not-allowed bg-[var(--primary-disabled)]"
      : checked
        ? "cursor-pointer bg-[var(--system-positive-strong)]"
        : "cursor-pointer bg-[var(--surface-active)]",
  );

  const knobClasses = cn(
    "absolute top-0.5 left-0.5 inline-block rounded-full shadow transition-transform",
    geometry.knob,
    disabled ? "bg-[var(--content-disabled)]" : "bg-[var(--aux-white)]",
    checked ? geometry.translate : "translate-x-0",
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
    return (
      <span data-slot="toggle" className={className}>
        {toggleButton}
      </span>
    );
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

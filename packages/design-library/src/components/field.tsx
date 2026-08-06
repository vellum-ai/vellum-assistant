import { type ReactNode } from "react";

import { Typography } from "./typography";
import { cn } from "../utils/cn";

/**
 * Label + helper/error scaffolding shared by the form controls.
 *
 * Internal to this package: controls compose it so that `label`, `helperText`
 * and `errorText` mean the same thing and look the same everywhere, rather
 * than each control reinventing them. Callers use those props on `Input`,
 * `Textarea` or `Select`. They never reach for this directly.
 *
 * The control owns its own id and wires its own `aria-describedby`; this only
 * renders the surrounding text. `errorText` wins over `helperText` when both
 * are present, so the user reads the blocking message rather than guidance
 * for a state they are not in.
 */
export interface FieldProps {
  /** The control's id. `label` targets it and messages derive their ids from it. */
  readonly id: string;
  readonly label?: ReactNode;
  readonly helperText?: ReactNode;
  readonly errorText?: ReactNode;
  readonly fullWidth: boolean;
  readonly disabled: boolean;
  readonly className?: string;
  readonly children: ReactNode;
}

/** The id of a control's message, matching what `Field` renders. */
export function fieldDescriptionId(
  controlId: string,
  hasError: boolean,
  hasHelper: boolean,
): string | undefined {
  return hasError
    ? `${controlId}-error`
    : hasHelper
      ? `${controlId}-helper`
      : undefined;
}

export function Field({
  id,
  label,
  helperText,
  errorText,
  fullWidth,
  disabled,
  className,
  children,
}: FieldProps) {
  const describedById = fieldDescriptionId(
    id,
    Boolean(errorText),
    Boolean(helperText),
  );

  return (
    <div
      data-slot="field-wrapper"
      className={cn(
        "flex flex-col gap-1.5",
        fullWidth ? "w-full" : "w-fit",
        className,
      )}
    >
      {label ? (
        <Typography
          as="label"
          id={`${id}-label`}
          variant="body-small-default"
          htmlFor={id}
          className={cn(
            "text-[var(--content-secondary)]",
            disabled && "opacity-60",
          )}
        >
          {label}
        </Typography>
      ) : null}
      {children}
      {errorText ? (
        <span
          id={describedById}
          role="alert"
          data-testid="field-error"
          className="text-body-small-default text-[var(--system-negative-strong)]"
        >
          {errorText}
        </span>
      ) : helperText ? (
        <span
          id={describedById}
          className="text-body-small-default text-[var(--content-tertiary)]"
        >
          {helperText}
        </span>
      ) : null}
    </div>
  );
}

import { cva, type VariantProps } from "class-variance-authority";
import {
  type ComponentProps,
  type ReactNode,
  useId,
} from "react";

import { Typography } from "./typography";
import { cn } from "../utils/cn";

/**
 * Shared text-input primitive backing both `Input` (single-line) and
 * `Textarea` (multi-line). Visual parity with the macOS design system input:
 * an `--surface-active` fill, a `--border-base` hairline that shifts to
 * `--border-element` on focus (or `--system-negative-strong` on error), and
 * `--content-default` text with a `--content-tertiary` placeholder.
 *
 * All colors resolve via CSS variable tokens, so the field inherits the
 * app's light/dark theming automatically.
 */
const fieldVariants = cva(
  [
    "block w-full rounded-md border bg-[var(--field-bg)]",
    "text-body-medium-lighter text-[var(--content-default)]",
    "placeholder:text-[var(--content-tertiary)]",
    "transition-[border-color,background-color] duration-150 ease-out",
    "outline-none",
    "disabled:cursor-not-allowed disabled:opacity-60",
  ].join(" "),
  {
    variants: {
      invalid: {
        true: [
          "border-[var(--system-negative-strong)]",
          "focus-visible:border-[var(--system-negative-strong)]",
        ].join(" "),
        false: [
          "border-[var(--field-border)]",
          "focus-visible:border-[var(--border-active)]",
        ].join(" "),
      },
      density: {
        input: "h-9 px-3 py-1.5",
        textarea: "min-h-[72px] px-3 py-2 resize-y",
      },
      hasLeftIcon: { true: "", false: "" },
      hasRightIcon: { true: "", false: "" },
    },
    compoundVariants: [
      { density: "input", hasLeftIcon: true, class: "pl-9" },
      { density: "input", hasRightIcon: true, class: "pr-9" },
    ],
    defaultVariants: {
      invalid: false,
      density: "input",
      hasLeftIcon: false,
      hasRightIcon: false,
    },
  },
);

type FieldVariantProps = VariantProps<typeof fieldVariants>;

interface FieldWrapperProps {
  readonly id: string;
  readonly label?: ReactNode;
  readonly helperText?: ReactNode;
  readonly errorText?: ReactNode;
  readonly fullWidth: boolean;
  readonly disabled: boolean;
  readonly className?: string;
  readonly children: ReactNode;
}

function FieldWrapper({
  id,
  label,
  helperText,
  errorText,
  fullWidth,
  disabled,
  className,
  children,
}: FieldWrapperProps) {
  const descriptionId = errorText
    ? `${id}-error`
    : helperText
      ? `${id}-helper`
      : undefined;

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
          id={descriptionId}
          role="alert"
          data-testid="input-error"
          className="text-body-small-default text-[var(--system-negative-strong)]"
        >
          {errorText}
        </span>
      ) : helperText ? (
        <span
          id={descriptionId}
          className="text-body-small-default text-[var(--content-tertiary)]"
        >
          {helperText}
        </span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Input (single-line)
// ---------------------------------------------------------------------------

export interface InputProps
  extends Omit<ComponentProps<"input">, "size"> {
  label?: ReactNode;
  helperText?: ReactNode;
  errorText?: ReactNode;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  fullWidth?: boolean;
  wrapperClassName?: string;
}

function Input({
  label,
  helperText,
  errorText,
  leftIcon,
  rightIcon,
  fullWidth = false,
  wrapperClassName,
  className,
  id,
  disabled,
  ref,
  "aria-invalid": ariaInvalid,
  "aria-describedby": ariaDescribedBy,
  ...rest
}: InputProps) {
  const reactId = useId();
  const inputId = id ?? `input-${reactId}`;
  const isInvalid = errorText != null || ariaInvalid === true;
  const describedBy = errorText
    ? `${inputId}-error`
    : helperText
      ? `${inputId}-helper`
      : undefined;

  return (
    <FieldWrapper
      id={inputId}
      label={label}
      helperText={helperText}
      errorText={errorText}
      fullWidth={fullWidth}
      disabled={disabled === true}
      className={wrapperClassName}
    >
      <div className="relative flex items-center">
        {leftIcon ? (
          <span
            aria-hidden
            data-testid="input-left-icon"
            className="pointer-events-none absolute left-3 flex items-center text-[var(--content-tertiary)]"
          >
            {leftIcon}
          </span>
        ) : null}
        <input
          {...rest}
          ref={ref}
          id={inputId}
          disabled={disabled}
          aria-invalid={isInvalid || undefined}
          aria-describedby={ariaDescribedBy ?? describedBy}
          data-slot="input"
          className={cn(
            fieldVariants({
              invalid: isInvalid,
              density: "input",
              hasLeftIcon: leftIcon != null,
              hasRightIcon: rightIcon != null,
            }),
            className,
          )}
        />
        {rightIcon ? (
          <span
            aria-hidden
            data-testid="input-right-icon"
            className="pointer-events-none absolute right-3 flex items-center text-[var(--content-tertiary)]"
          >
            {rightIcon}
          </span>
        ) : null}
      </div>
    </FieldWrapper>
  );
}

// ---------------------------------------------------------------------------
// Textarea (multi-line)
// ---------------------------------------------------------------------------

export interface TextareaProps extends ComponentProps<"textarea"> {
  label?: ReactNode;
  helperText?: ReactNode;
  errorText?: ReactNode;
  fullWidth?: boolean;
  wrapperClassName?: string;
}

function Textarea({
  label,
  helperText,
  errorText,
  fullWidth = false,
  wrapperClassName,
  className,
  id,
  disabled,
  ref,
  "aria-invalid": ariaInvalid,
  "aria-describedby": ariaDescribedBy,
  ...rest
}: TextareaProps) {
  const reactId = useId();
  const textareaId = id ?? `textarea-${reactId}`;
  const isInvalid = errorText != null || ariaInvalid === true;
  const describedBy = errorText
    ? `${textareaId}-error`
    : helperText
      ? `${textareaId}-helper`
      : undefined;

  return (
    <FieldWrapper
      id={textareaId}
      label={label}
      helperText={helperText}
      errorText={errorText}
      fullWidth={fullWidth}
      disabled={disabled === true}
      className={wrapperClassName}
    >
      <textarea
        {...rest}
        ref={ref}
        id={textareaId}
        disabled={disabled}
        aria-invalid={isInvalid || undefined}
        aria-describedby={ariaDescribedBy ?? describedBy}
        data-slot="textarea"
        className={cn(
          fieldVariants({
            invalid: isInvalid,
            density: "textarea",
            hasLeftIcon: false,
            hasRightIcon: false,
          }),
          className,
        )}
      />
    </FieldWrapper>
  );
}

export {
  Input,
  Textarea,
  fieldVariants,
  type FieldVariantProps,
};

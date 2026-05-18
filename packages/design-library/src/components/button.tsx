import { type ComponentProps, type ReactNode } from "react";

import { cn } from "../utils/cn.js";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "outlined";
export type ButtonSize = "sm" | "md" | "lg" | "compact";

export interface ButtonProps extends ComponentProps<"button"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Icon rendered before the text label. */
  leftIcon?: ReactNode;
  /** Icon rendered after the text label. */
  rightIcon?: ReactNode;
  /**
   * Render as an icon-only button. The node is centered and `children`,
   * `leftIcon`, and `rightIcon` are ignored.
   */
  iconOnly?: ReactNode;
  children?: ReactNode;
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    "bg-[var(--primary-active)] text-white hover:bg-[var(--primary-hover)]",
  secondary:
    "bg-[var(--surface-lift)] text-[var(--content-default)] hover:bg-[var(--surface-active)]",
  ghost:
    "bg-transparent text-[var(--content-secondary)] hover:bg-[var(--surface-lift)] hover:text-[var(--content-default)]",
  outlined:
    "border border-[var(--border-base)] bg-transparent text-[var(--content-secondary)] hover:bg-[var(--surface-base)] hover:text-[var(--content-default)]",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: "h-7 gap-1.5 rounded-md px-2.5 text-body-small-default",
  md: "h-9 gap-2 rounded-lg px-3.5 text-body-medium-default",
  lg: "h-11 gap-2.5 rounded-lg px-5 text-body-large-default",
  compact: "h-6 gap-1.5 rounded-md px-2 text-label-medium-default",
};

const ICON_ONLY_SIZE: Record<ButtonSize, string> = {
  sm: "size-7",
  md: "size-9",
  lg: "size-11",
  compact: "size-6",
};

const ICON_SIZE: Record<ButtonSize, string> = {
  sm: "[&_svg]:size-3.5",
  md: "[&_svg]:size-4",
  lg: "[&_svg]:size-5",
  compact: "[&_svg]:size-3.5",
};

export function Button({
  variant = "primary",
  size = "md",
  leftIcon,
  rightIcon,
  iconOnly,
  className,
  children,
  ref,
  ...props
}: ButtonProps) {
  const isIconOnly = iconOnly != null && iconOnly !== false;

  return (
    <button
      ref={ref}
      data-slot="button"
      className={cn(
        "inline-flex shrink-0 cursor-pointer items-center justify-center transition-colors disabled:pointer-events-none disabled:opacity-50",
        VARIANT_CLASSES[variant],
        isIconOnly
          ? cn("rounded-lg p-0", ICON_ONLY_SIZE[size])
          : SIZE_CLASSES[size],
        ICON_SIZE[size],
        className,
      )}
      {...props}
    >
      {isIconOnly ? (
        <span aria-hidden="true" className="inline-flex items-center justify-center">
          {iconOnly}
        </span>
      ) : (
        <>
          {leftIcon && (
            <span aria-hidden="true" className="inline-flex shrink-0">
              {leftIcon}
            </span>
          )}
          {children}
          {rightIcon && (
            <span aria-hidden="true" className="inline-flex shrink-0">
              {rightIcon}
            </span>
          )}
        </>
      )}
    </button>
  );
}

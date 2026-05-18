import { type ComponentProps, type ReactNode } from "react";

import { cn } from "../utils/cn.js";

export interface ButtonProps extends ComponentProps<"button"> {
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md" | "lg";
  children: ReactNode;
}

const VARIANT_CLASSES: Record<NonNullable<ButtonProps["variant"]>, string> = {
  primary: "vdl-btn-primary",
  secondary: "vdl-btn-secondary",
  ghost: "vdl-btn-ghost",
};

const SIZE_CLASSES: Record<NonNullable<ButtonProps["size"]>, string> = {
  sm: "vdl-btn-sm",
  md: "vdl-btn-md",
  lg: "vdl-btn-lg",
};

export function Button({
  variant = "primary",
  size = "md",
  className,
  children,
  ref,
  ...props
}: ButtonProps) {
  return (
    <button
      ref={ref}
      data-slot="button"
      className={cn("vdl-btn", VARIANT_CLASSES[variant], SIZE_CLASSES[size], className)}
      {...props}
    >
      {children}
    </button>
  );
}

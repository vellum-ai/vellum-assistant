import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { LucideIcon } from "lucide-react";
import { forwardRef, type ButtonHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

const iconSizeMap = {
  sm: "h-4 w-4",
  md: "h-4 w-4",
  lg: "h-5 w-5",
  icon: "h-5 w-5",
} as const;

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap font-display font-semibold rounded-meadow transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-dino-400/30 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        primary: "bg-poppy-400 text-white hover:bg-poppy-500",
        secondary: "bg-meadow-500 text-white hover:bg-meadow-600",
        ghost: "hover:bg-cloud-100 dark:hover:bg-sky-700",
        outline:
          "border border-cloud-300 hover:bg-cloud-50 dark:border-sky-600 dark:hover:bg-sky-700",
        danger: "bg-red-600 text-white hover:bg-red-700",
      },
      size: {
        sm: "h-8 px-3 text-sm",
        md: "h-10 px-4 text-sm",
        lg: "h-12 px-6 text-base",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
  }
);

interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  icon?: LucideIcon;
  iconPosition?: "start" | "end";
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant,
      size,
      asChild = false,
      icon: Icon,
      iconPosition = "start",
      children,
      ...props
    },
    ref
  ) => {
    if (asChild) {
      return (
        <Slot
          className={cn(buttonVariants({ variant, size, className }))}
          ref={ref}
          {...props}
        >
          {children}
        </Slot>
      );
    }

    const iconClass = iconSizeMap[size ?? "md"];

    return (
      <button
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      >
        {Icon && iconPosition === "start" && <Icon className={iconClass} />}
        {children}
        {Icon && iconPosition === "end" && <Icon className={iconClass} />}
      </button>
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
export type { ButtonProps };

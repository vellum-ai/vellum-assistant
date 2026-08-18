import { type ReactNode } from "react";

import { cn } from "@vellumai/design-library";

/**
 * Centered, negative-toned error line shared across the login surfaces, so the
 * error styling stays consistent wherever a login flow surfaces a failure.
 * `className` merges for per-surface layout tweaks (e.g. a width clamp).
 */
export function LoginErrorText({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <p
      className={cn(
        "text-body-small-default text-center text-[var(--system-negative-strong)]",
        className,
      )}
    >
      {children}
    </p>
  );
}

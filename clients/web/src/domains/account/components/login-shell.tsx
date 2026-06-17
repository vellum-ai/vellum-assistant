import { type ReactNode } from "react";

import { cn } from "@vellumai/design-library";

import { LoginBackground } from "@/domains/account/login-background";

const CARD_CLASS =
  "flex w-full max-w-[448px] flex-col gap-6 rounded-lg border border-[var(--border-disabled)] bg-[var(--surface-lift)] p-6";

export function LoginCard({ children }: { children: ReactNode }) {
  return <div className={CARD_CLASS}>{children}</div>;
}

/** Branded login heading, centered with the emphasised content token. */
export function LoginHeading({ children }: { children: ReactNode }) {
  return (
    <h1 className="text-title-large text-center text-[var(--content-emphasised)]">
      {children}
    </h1>
  );
}

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

/** Forced-dark full-screen shell with the branded gradient background. */
export function DarkLoginShell({ children }: { children: ReactNode }) {
  return (
    <div className="dark">
      <div className="relative min-h-screen overflow-x-hidden bg-[var(--surface-base)] text-[var(--content-default)]">
        <LoginBackground />
        <div className="relative z-10 flex min-h-screen flex-col items-center justify-center px-4">
          {children}
        </div>
      </div>
    </div>
  );
}

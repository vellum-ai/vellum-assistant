import { type ReactNode } from "react";

import { LoginBackground } from "@/domains/account/login-background";

const CARD_CLASS =
  "flex w-full max-w-[448px] flex-col gap-6 rounded-lg border border-[var(--border-disabled)] bg-[var(--surface-lift)] p-6";

export function LoginCard({ children }: { children: ReactNode }) {
  return <div className={CARD_CLASS}>{children}</div>;
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

import type { ReactNode } from "react";

import { CreatureFooter } from "./creature-footer";

/**
 * Shared chrome for the onboarding screens: a full-height dark surface with
 * the decorative creature footer pinned to the bottom. Caller owns the inner
 * column's layout and padding.
 */
export function OnboardingLayout({ children }: { children: ReactNode }) {
  return (
    <div className="relative min-h-screen overflow-hidden bg-[var(--surface-base)]">
      {children}
      <CreatureFooter />
    </div>
  );
}

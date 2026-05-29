import type { ReactNode } from "react";

import { CreatureFooter } from "./creature-footer";

/**
 * Shared chrome for the onboarding screens: a full-height dark surface with
 * the decorative creature footer pinned to the bottom. Caller owns the inner
 * column's layout and padding.
 *
 * The outer div fills the RootLayout's fixed-height (100dvh) shell. Children
 * render inside a flex-1 scroll container so screens whose content exceeds
 * the viewport (e.g. ToolSelectionScreen on iPhone 13 mini) become scrollable
 * instead of clipping the Continue button off-screen. The CreatureFooter sits
 * outside the scroll container so it stays at the viewport bottom.
 */
export function OnboardingLayout({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex h-full flex-col bg-[var(--surface-base)]">
      <div className="flex-1 overflow-y-auto">
        {children}
      </div>
      <CreatureFooter />
    </div>
  );
}

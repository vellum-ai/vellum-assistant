import { useState, type ReactNode } from "react";

import { PortalContainerProvider } from "@vellumai/design-library/utils/portal-container";
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
 *
 * Overlay components (e.g. the provider Dropdown menu) portal into the
 * trailing at-origin element below — outside the centered, animated content
 * column. Without it the Dropdown renders inline and its position:fixed menu
 * anchors to the column's containing block (created by the column's transform
 * animation) instead of the viewport, landing far off to the side.
 */
export function OnboardingLayout({
  children,
  showCreatureFooter = true,
}: {
  children: ReactNode;
  /**
   * Whether to render the decorative creature footer. Defaults to `true` for
   * the branded onboarding pages (welcome, hatching, etc.); the prechat funnel
   * steps pass `false` for a cleaner, footer-free layout.
   */
  showCreatureFooter?: boolean;
}) {
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(
    null,
  );

  return (
    <div className="relative flex h-full flex-col bg-[var(--surface-base)]">
      <div className="flex-1 overflow-y-auto">
        <PortalContainerProvider container={portalContainer}>
          {children}
        </PortalContainerProvider>
      </div>
      {showCreatureFooter && <CreatureFooter />}
      <div ref={setPortalContainer} />
    </div>
  );
}

import { useState, type ReactNode } from "react";

import { PortalContainerProvider } from "@vellumai/design-library/utils/portal-container";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { isElectron } from "@/runtime/is-electron";
import { AvatarWave } from "./avatar-wave";
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
 * Overlay components (e.g. the provider Select menu) portal into the
 * trailing at-origin element below — outside the centered, animated content
 * column. Without it the menu renders inline and anchors to the column's
 * containing block (created by the column's transform animation) instead of
 * the viewport, landing far off to the side.
 */
export function OnboardingLayout({
  children,
  showCreatureFooter = true,
  showAvatarWave = false,
  animateAvatarWaveIn = false,
}: {
  children: ReactNode;
  /**
   * Whether to render the decorative creature footer. Defaults to `true` for
   * the branded onboarding pages (welcome, hatching, etc.); the prechat funnel
   * steps pass `false` for a cleaner, footer-free layout.
   */
  showCreatureFooter?: boolean;
  /**
   * Whether to seat the content beside the live avatar wave. The wave needs
   * a column of its own, so it is only offered from the `md` breakpoint up;
   * narrower viewports keep the single-column layout and the creature footer
   * rather than surrendering half the screen to decoration.
   */
  showAvatarWave?: boolean;
  /**
   * Ask the wave to play its entrance rather than appear settled. Reserved
   * for the screen a visit starts on: the wave spans a run of screens that
   * each mount their own copy, and pouring it in again at every step reads
   * as the page restarting. Ignored without `showAvatarWave`, and the wave
   * itself plays the entrance at most once per session.
   */
  animateAvatarWaveIn?: boolean;
}) {
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(
    null,
  );
  // Matches the `md` breakpoint. Gating in render (rather than with a
  // `hidden md:block` class) keeps the wave's canvas and its animation loop
  // from mounting at all on the layout that would not show them.
  const isMobile = useIsMobile();
  // The desktop shell runs its own compact, top-aligned onboarding flow in a
  // window narrow enough that surrendering half of it to decoration would
  // crowd the step content.
  const withWave = showAvatarWave && !isMobile && !isElectron();

  const content = (
    <div className="flex-1 overflow-y-auto">
      <PortalContainerProvider container={portalContainer}>
        {children}
      </PortalContainerProvider>
    </div>
  );

  return (
    <div className="relative flex h-full flex-col bg-[var(--surface-base)]">
      {withWave ? (
        <div className="flex min-h-0 flex-1">
          {content}
          <div className="relative w-[46%] lg:w-1/2">
            <AvatarWave className="absolute inset-0" entrance={animateAvatarWaveIn} />
          </div>
        </div>
      ) : (
        content
      )}
      {showCreatureFooter && !withWave && <CreatureFooter />}
      <div ref={setPortalContainer} />
    </div>
  );
}

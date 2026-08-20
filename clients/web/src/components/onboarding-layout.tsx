import { useState, type ReactNode } from "react";

import { PortalContainerProvider } from "@vellumai/design-library/utils/portal-container";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useMediaQuery } from "@/hooks/use-media-query";
import { isElectron } from "@/runtime/is-electron";
import { AvatarWave, WRAP_WAVE_MIN_HEIGHT_QUERY } from "./avatar-wave";
import { CreatureFooter } from "./creature-footer";

/** See {@link OnboardingLayout}'s `avatarWave` prop. */
export type AvatarWavePlacement = "none" | "beside" | "around";

/**
 * Shared chrome for the pre-app screens — the onboarding funnel and the
 * welcome screen both front doors show (`/assistant/welcome` and
 * `/account/login`): a full-height dark surface with the decorative creature
 * footer pinned to the bottom. Caller owns the inner column's layout and
 * padding.
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
  avatarWave = "none",
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
   * Where the live avatar wave goes. Either setting stands in for the
   * creature footer wherever it actually renders.
   *
   * `beside` seats it in a column next to the content from the `md`
   * breakpoint up, and leaves narrower viewports the footer. The wave needs
   * a column of its own, and surrendering half a phone screen to decoration
   * is not one. `around` does the same above `md` and, below it, wraps the
   * wave around the content instead: a thread arcing over the heading, off
   * the edge, and back in under the buttons as the crowd.
   *
   * `around` asks two things of a step, and a step that fails either keeps
   * `beside`:
   *
   * Its content has to clear the wave at the shortest screen the wrap runs
   * on, which is a 640-tall phone, not a 844-tall one. The step's column is
   * a fixed stack of controls centred in what the padding leaves it, so it
   * keeps its height as the screen shrinks and spreads across more of it:
   * measure there or the check passes on a screen that was never the
   * problem. The thread takes the top fifth, and the crowd comes back in on
   * the right at about 0.59 of the height, sloping down to 0.85 at the left,
   * so a full-width control below roughly 0.58 lands in the crowd and a
   * heading above 0.2 lands under the thread. Narrow centred content can sit
   * lower, where the crowd has not reached the middle yet.
   *
   * Its content also has to be bounded. A step rendering a list it does not
   * cap has no height to check: it fits until a user with enough assistants
   * arrives, and then it scrolls its cards through both.
   */
  avatarWave?: AvatarWavePlacement;
  /**
   * Ask the wave to play its entrance rather than appear settled. Reserved
   * for the screen a visit starts on: the wave spans a run of screens that
   * each mount their own copy, and pouring it in again at every step reads
   * as the page restarting. Ignored without a wave, and the wave itself
   * plays the entrance at most once per session.
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
  // A viewport can be narrow enough to have no column to spare and still be
  // too short to wrap: a phone in landscape, or a small window. See
  // `WRAP_WAVE_MIN_HEIGHT_QUERY`. Those fall through to the footer.
  const isTallEnoughToWrap = useMediaQuery(WRAP_WAVE_MIN_HEIGHT_QUERY);
  // The desktop shell runs its own compact, top-aligned onboarding flow in a
  // window that has neither half a screen to give to decoration nor the
  // centred column the wrap composition goes around, so it keeps the footer.
  const electron = isElectron();
  const columnWave = avatarWave !== "none" && !isMobile && !electron;
  const wrapWave =
    avatarWave === "around" && isMobile && isTallEnoughToWrap && !electron;

  const content = (
    <div className="flex-1 overflow-y-auto">
      <PortalContainerProvider container={portalContainer}>
        {children}
      </PortalContainerProvider>
    </div>
  );

  return (
    // `isolate` is what puts the wrap wave behind the content: without a
    // stacking context here, its negative z-index would drop it behind this
    // element's own background and paint nothing at all.
    <div className="relative isolate flex h-full flex-col bg-[var(--surface-base)]">
      {wrapWave && (
        <AvatarWave
          variant="wrap"
          entrance={animateAvatarWaveIn}
          // `fixed`, for the reason `CreatureFooter` is: this layout sits
          // inside `RootLayout`'s safe-area padding, and an `absolute` wave
          // would stop short of the physical bottom edge, cutting the crowd
          // off above a strip of bare surface on iOS. The crowd is authored
          // to pour off the bottom, so it has to reach one.
          className="fixed inset-0 -z-10"
        />
      )}
      {columnWave ? (
        <div className="flex min-h-0 flex-1">
          {content}
          <div className="relative w-[46%] lg:w-1/2">
            <AvatarWave className="absolute inset-0" entrance={animateAvatarWaveIn} />
          </div>
        </div>
      ) : (
        content
      )}
      {showCreatureFooter && !columnWave && !wrapWave && <CreatureFooter />}
      <div ref={setPortalContainer} />
    </div>
  );
}

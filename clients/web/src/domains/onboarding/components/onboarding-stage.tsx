/**
 * The box the onboarding decorative layers position themselves against.
 *
 * Every onboarding screen puts its content inside one of these. It measures
 * itself and publishes that size through `OnboardingStageSizeProvider`, so the
 * decorative layers (the character stage, the peeking crowd, the bottom eyes,
 * the coin arc) resolve their `absolute` positions against the same box the
 * `%`-positioned foreground uses.
 *
 * Measuring the container rather than the layout viewport is the point. The app
 * shell is `100dvh` minus the safe-area insets, and shorter still while the iOS
 * keyboard is up, so a layer sized from `window.innerHeight` sits in a taller
 * coordinate space than the content it is supposed to be pinned to. See
 * `use-element-size.ts` for the same hazard stated from the other side.
 *
 * The stage is also the page's canvas, so it hands its color to the app shell
 * (see `page-surface-store`): the safe-area strips are padding on the shell, so
 * without this the home indicator sits on the shell's light `--surface-base`
 * while the stage renders dark or avatar-tinted, leaving a pale band along the
 * bottom edge on iOS.
 *
 * This exists as a component rather than a snippet each screen repeats because
 * a story that mirrors the wrapper proves nothing about the real one: the two
 * drift, and the story keeps passing. Screens differ only in the surface they
 * paint, so that is the only prop.
 */

import { type ReactNode } from "react";

import { OnboardingStageSizeProvider } from "@/domains/onboarding/hooks/use-onboarding-stage-size";
import { ONBOARDING_DARK_SURFACE } from "@/domains/onboarding/onboarding-step-layout";
import { useElementSize } from "@/hooks/use-element-size";
import { usePublishPageSurface } from "@/stores/page-surface-store";
import { cn } from "@/utils/misc";

interface OnboardingStageProps {
  /** Surface classes for this screen (background, text colour). */
  className?: string;
  /**
   * The color the shell should paint into the safe-area strips. Defaults to the
   * dark surface every screen inherits from the stage's own theme; pass the
   * avatar color on a screen tinted with it, or `null` on a screen whose color
   * is owned and animated by a child layer (that layer publishes instead).
   */
  surface?: string | null;
  /**
   * How the strips should reach {@link OnboardingStageProps.surface}: the tail
   * of a CSS `transition` shorthand, mirroring the screen's own motion timing
   * when its canvas fades in rather than appearing at once. Omit to change the
   * strips in one frame.
   */
  surfaceTransition?: string;
  /**
   * Optional: a screen waiting on its art renders the stage bare rather than
   * standing up a plain div, which would publish no surface and leave the
   * strips on the neutral canvas.
   */
  children?: ReactNode;
}

export function OnboardingStage({
  className,
  surface = ONBOARDING_DARK_SURFACE,
  surfaceTransition,
  children,
}: OnboardingStageProps) {
  const { ref, size } = useElementSize();

  usePublishPageSurface(surface, surfaceTransition ?? null);

  return (
    <div
      ref={ref}
      data-theme="dark"
      className={cn("relative h-full overflow-hidden", className)}
    >
      <OnboardingStageSizeProvider size={size}>
        {children}
      </OnboardingStageSizeProvider>
    </div>
  );
}

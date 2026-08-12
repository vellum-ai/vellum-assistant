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
 * This exists as a component rather than a snippet each screen repeats because
 * a story that mirrors the wrapper proves nothing about the real one: the two
 * drift, and the story keeps passing. Screens differ only in the surface they
 * paint, so that is the only prop.
 */

import { type ReactNode } from "react";

import { OnboardingStageSizeProvider } from "@/domains/onboarding/hooks/use-onboarding-stage-size";
import { useElementSize } from "@/hooks/use-element-size";
import { cn } from "@/utils/misc";

interface OnboardingStageProps {
  /** Surface classes for this screen (background, text colour). */
  className?: string;
  children: ReactNode;
}

export function OnboardingStage({ className, children }: OnboardingStageProps) {
  const { ref, size } = useElementSize();

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

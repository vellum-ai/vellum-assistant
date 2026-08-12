/**
 * Shared setup for the onboarding decorative-layer stories.
 *
 * Both pieces here exist because getting them wrong produces a story that
 * renders nothing, or renders against the wrong box, without erroring:
 *
 * - `StageHost` supplies the height contract `OnboardingStage` depends on.
 * - `SeededAvatarPool` fills the character pool the layers draw from.
 *
 * Not a `.stories.tsx` file, so Storybook does not index it.
 */

import { useEffect, type ReactNode } from "react";

import { useOnboardingAvatarPoolStore } from "@/domains/onboarding/onboarding-avatar-pool-store";
import { useBundledAvatarComponents } from "@/utils/use-bundled-avatar-components";

/**
 * The height contract `OnboardingStage` relies on.
 *
 * `OnboardingStage` is `h-full`, so it is however tall its parent makes it. In
 * the app that parent is the shell in `root-layout.tsx`: a `100dvh` flex column
 * (minus the safe-area padding) whose route slot is `flex: 1 1 0%` with
 * `min-height: 0`. Mounted without that chain the stage measures zero tall,
 * every layer resolves against a zero-height box, and the whole arrangement
 * collapses to the origin without erroring.
 *
 * `insetTop` / `insetBottom` stand in for `env(safe-area-inset-*)`, which the
 * shell applies and Storybook cannot produce. That is the one thing here
 * standing in for the app rather than reproducing it, and it is the point of
 * the inset stories: on a 390x844 viewport with the iPhone 15 Pro's insets the
 * stage measures 390x751, so a layer reading the window is 93px out.
 *
 * Mirrored rather than imported because the contract lives inline in the app
 * shell around `<Outlet />`, tangled with its keyboard and safe-area handling.
 * If it is ever extracted, this should import it instead.
 */
export function StageHost({
  children,
  insetTop = 0,
  insetBottom = 0,
  insetLeft = 0,
  insetRight = 0,
}: {
  children: ReactNode;
  insetTop?: number;
  insetBottom?: number;
  /**
   * Horizontal insets, which the shell applies in landscape on a notched
   * device. They make the stage narrower than the layout viewport, which is
   * the case a `vw`-anchored child gets wrong.
   */
  insetLeft?: number;
  insetRight?: number;
}) {
  return (
    <div
      className="flex w-screen flex-col bg-[var(--surface-sunken)]"
      style={{
        height: "100dvh",
        paddingTop: insetTop,
        paddingBottom: insetBottom,
        paddingLeft: insetLeft,
        paddingRight: insetRight,
      }}
    >
      <div
        className="flex w-full min-w-0 flex-col overflow-hidden"
        style={{ flex: "1 1 0%", minHeight: 0 }}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Fills the avatar pool the way the app does, then renders `children`.
 *
 * The decorative layers draw the *chosen* character's art and return `null`
 * until the pool has one, so a story that skips this renders an empty stage and
 * still passes. Seeding goes through `ensureGenerated`, the same write path
 * `GiveMeAFaceScreen` uses, rather than pushing state in behind it.
 */
export function SeededAvatarPool({ children }: { children: ReactNode }) {
  const components = useBundledAvatarComponents();
  const characters = useOnboardingAvatarPoolStore.use.characters();
  const ensureGenerated = useOnboardingAvatarPoolStore.use.ensureGenerated();

  useEffect(() => {
    if (components) {
      ensureGenerated(components);
    }
  }, [components, ensureGenerated]);

  if (!components || characters.length === 0) {
    return null;
  }
  return <>{children}</>;
}

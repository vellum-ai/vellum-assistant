/**
 * The introduction screen opens on the picker's dark surface and fades the
 * avatar tint in over it, so the safe-area strips the app shell paints have to
 * start dark and follow rather than opening on the tint.
 *
 * The regression this guards is the Back path from the pitch step, where the
 * toned backdrop has already published this same hex: publishing the tint on
 * mount is no color change at all, so nothing transitions and the strips sit
 * tinted through the whole fade. Asserted as a sequence, since the dark start
 * and the tint land in different commits. See `page-surface-store`.
 */

import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("@/utils/use-bundled-avatar-components", () => ({
  useBundledAvatarComponents: () => ({
    colors: [{ id: "teal", hex: "#2AA79B" }],
    bodyShapes: [
      {
        id: "urchin",
        svgPath: "M0 0h10v10H0z",
        viewBox: { width: 10, height: 10 },
      },
    ],
  }),
}));

// Decorative, and it measures itself; the surface handover is what is under
// test here.
mock.module("@/domains/onboarding/components/onboarding-peeking-eyes", () => ({
  OnboardingPeekingEyes: () => null,
}));

const { IntroductionScreen } =
  await import("@/domains/onboarding/screens/introduction-screen");
const { useOnboardingAvatarPoolStore } =
  await import("@/domains/onboarding/onboarding-avatar-pool-store");
const { usePageSurfaceStore } = await import("@/stores/page-surface-store");
const { ONBOARDING_DARK_SURFACE } =
  await import("@/domains/onboarding/onboarding-step-layout");

const TEAL = "#2AA79B";
const TINT_FADE_CSS = "0.6s ease-out 0.35s";

/** Every surface the screen publishes, in order, as `color|transition`. */
function recordPublishes(): { steps: string[]; stop: () => void } {
  const steps: string[] = [];
  const stop = usePageSurfaceStore.subscribe((state) => {
    steps.push(`${state.surface}|${state.transition}`);
  });
  return { steps, stop };
}

function renderScreen() {
  return render(
    <IntroductionScreen
      firstName="Ada"
      assistantName="Viper"
      onContinue={() => {}}
      onBack={() => {}}
      onForward={() => {}}
    />,
  );
}

beforeEach(() => {
  useOnboardingAvatarPoolStore.setState({
    characters: [{ bodyShape: "urchin", eyeStyle: "goofy", color: "teal" }],
    selectedIndex: 0,
  });
});

afterEach(() => {
  cleanup();
  usePageSurfaceStore.getState().setSurface(null);
  useOnboardingAvatarPoolStore.setState({ characters: [], selectedIndex: 0 });
});

describe("IntroductionScreen surface handover", () => {
  test("opens on the dark surface, then fades to the tint", () => {
    const { steps, stop } = recordPublishes();
    const { unmount } = renderScreen();
    stop();

    expect(steps).toEqual([
      `${ONBOARDING_DARK_SURFACE}|null`,
      `${TEAL}|${TINT_FADE_CSS}`,
    ]);
    unmount();
  });

  test("starts dark even when the strips already carry the tint", () => {
    // The Back path from the pitch step: the backdrop left the strips on this
    // same hex, so a mount that published the tint would be no change at all
    // and the shell would have nothing to transition.
    usePageSurfaceStore.getState().setSurface(TEAL);

    const { steps, stop } = recordPublishes();
    const { unmount } = renderScreen();
    stop();

    expect(steps[0]).toBe(`${ONBOARDING_DARK_SURFACE}|null`);
    expect(steps.at(-1)).toBe(`${TEAL}|${TINT_FADE_CSS}`);
    unmount();
  });
});

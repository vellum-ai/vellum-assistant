/**
 * The toned backdrop owns the canvas color on the tinted onboarding steps, so
 * it is what hands that color to the app shell for the safe-area strips.
 *
 * What these pin is the timing rule it shares with its own `initial={false}`
 * canvas: take the color outright on arrival, animate only when the target
 * changes. Publishing the mount value with a transition would leave a journey
 * resumed straight onto a toned step fading its strips up from the neutral
 * canvas while the page was already tinted. See `page-surface-store`.
 */

import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("@/utils/use-bundled-avatar-components", () => ({
  useBundledAvatarComponents: () => ({
    colors: [
      { id: "teal", hex: "#2AA79B" },
      { id: "pink", hex: "#E86AA5" },
      { id: "yellow", hex: "#E5C100" },
    ],
    bodyShapes: [],
    eyeStyles: [],
  }),
}));

// Decorative layers that measure and animate themselves; the surface handover
// is what is under test.
mock.module("@/domains/onboarding/components/onboarding-peeking-eyes", () => ({
  OnboardingPeekingEyes: () => null,
}));
mock.module("@/components/avatar/animated-avatar", () => ({
  AnimatedAvatar: () => null,
}));

const { OnboardingTonedBackdrop } =
  await import("@/domains/onboarding/components/onboarding-toned-backdrop");
const { useOnboardingAvatarPoolStore } =
  await import("@/domains/onboarding/onboarding-avatar-pool-store");
const { usePageSurfaceStore } = await import("@/stores/page-surface-store");
const { ONBOARDING_DARK_SURFACE } =
  await import("@/domains/onboarding/onboarding-step-layout");

const TEAL = "#2AA79B";
const CANVAS_FADE_CSS = "1s ease-in-out";

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

describe("OnboardingTonedBackdrop surface handover", () => {
  test("takes the tint outright on arrival", () => {
    const { unmount } = render(<OnboardingTonedBackdrop />);

    expect(usePageSurfaceStore.getState().surface).toBe(TEAL);
    expect(usePageSurfaceStore.getState().transition).toBeNull();
    unmount();
  });

  test("crossfades to the post-calendar dark once mounted", () => {
    const { rerender, unmount } = render(<OnboardingTonedBackdrop />);

    rerender(<OnboardingTonedBackdrop darkBg />);

    expect(usePageSurfaceStore.getState().surface).toBe(
      ONBOARDING_DARK_SURFACE,
    );
    expect(usePageSurfaceStore.getState().transition).toBe(CANVAS_FADE_CSS);
    unmount();
  });

  test("releases the surface on unmount", () => {
    const { unmount } = render(<OnboardingTonedBackdrop />);
    unmount();

    expect(usePageSurfaceStore.getState().surface).toBeNull();
  });
});

/**
 * The onboarding stage hands its color to the app shell so the safe-area
 * strips match the screen instead of leaving a pale band along the bottom
 * edge on iOS. See `page-surface-store`.
 */

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";

import { OnboardingStage } from "@/domains/onboarding/components/onboarding-stage";
import { ONBOARDING_DARK_SURFACE } from "@/domains/onboarding/onboarding-step-layout";
import { usePageSurfaceStore } from "@/stores/page-surface-store";

afterEach(() => {
  cleanup();
  usePageSurfaceStore.getState().setSurface(null);
});

describe("OnboardingStage", () => {
  test("publishes the dark surface it themes itself with", () => {
    render(<OnboardingStage>content</OnboardingStage>);

    expect(usePageSurfaceStore.getState().surface).toBe(
      ONBOARDING_DARK_SURFACE,
    );
  });

  test("publishes a screen's own tint when it is given one", () => {
    render(<OnboardingStage surface="#E5C100">content</OnboardingStage>);

    expect(usePageSurfaceStore.getState().surface).toBe("#E5C100");
  });

  test("leaves the surface alone when a child layer owns the color", () => {
    render(<OnboardingStage surface={null}>content</OnboardingStage>);

    expect(usePageSurfaceStore.getState().surface).toBeNull();
  });

  test("releases the surface on unmount", () => {
    const { unmount } = render(<OnboardingStage>content</OnboardingStage>);
    unmount();

    expect(usePageSurfaceStore.getState().surface).toBeNull();
  });
});

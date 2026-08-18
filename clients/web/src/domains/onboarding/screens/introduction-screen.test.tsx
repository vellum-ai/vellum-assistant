/**
 * The introduction screen opens on the picker's dark surface and fades the
 * avatar tint in over it, so the safe-area strips the app shell paints have to
 * start dark and follow.
 *
 * The regression this guards is the Back path from the pitch step, where the
 * toned backdrop has already published this same hex. Two ways to get that
 * wrong, and the tests cover both: publishing the tint on mount is no color
 * change for the shell to transition, and publishing it from a passive effect
 * is not a paint boundary either, so both writes coalesce into one style
 * recalculation and the computed color never leaves the tint.
 *
 * Animation frames are therefore driven by hand here, so "the tint waits for a
 * painted frame" is what the test actually asserts rather than something the
 * environment happens to do. See `page-surface-store`.
 */

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

/** Null while the bundled-art import is outstanding, or if it failed. */
let bundledArt: unknown = {
  colors: [{ id: "teal", hex: "#2AA79B" }],
  bodyShapes: [
    {
      id: "urchin",
      svgPath: "M0 0h10v10H0z",
      viewBox: { width: 10, height: 10 },
    },
  ],
};

mock.module("@/utils/use-bundled-avatar-components", () => ({
  useBundledAvatarComponents: () => bundledArt,
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

/** Frames the component asked for, run only when a test says so. */
let frames: FrameRequestCallback[] = [];
const realRaf = globalThis.requestAnimationFrame;
const realCancelRaf = globalThis.cancelAnimationFrame;

/** Run every frame requested so far. Callbacks may request further frames. */
function paintFrame() {
  const due = frames;
  frames = [];
  act(() => {
    for (const frame of due) {
      frame(0);
    }
  });
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
  bundledArt = {
    colors: [{ id: "teal", hex: "#2AA79B" }],
    bodyShapes: [
      {
        id: "urchin",
        svgPath: "M0 0h10v10H0z",
        viewBox: { width: 10, height: 10 },
      },
    ],
  };
  frames = [];
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) =>
    frames.push(callback)) as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;
  useOnboardingAvatarPoolStore.setState({
    characters: [{ bodyShape: "urchin", eyeStyle: "goofy", color: "teal" }],
    selectedIndex: 0,
  });
});

afterEach(() => {
  cleanup();
  globalThis.requestAnimationFrame = realRaf;
  globalThis.cancelAnimationFrame = realCancelRaf;
  usePageSurfaceStore.getState().setSurface(null);
  useOnboardingAvatarPoolStore.setState({ characters: [], selectedIndex: 0 });
});

describe("IntroductionScreen surface handover", () => {
  test("holds the dark surface until a frame has painted it", () => {
    // The Back path from the pitch step: the strips already carry this hex, so
    // publishing the tint before the dark one paints leaves the shell with no
    // color change to transition.
    usePageSurfaceStore.getState().setSurface(TEAL);

    const { unmount } = renderScreen();

    expect(usePageSurfaceStore.getState().surface).toBe(
      ONBOARDING_DARK_SURFACE,
    );
    expect(usePageSurfaceStore.getState().transition).toBeNull();

    // The frame the dark value is painted in. Still too early: this callback
    // runs before the browser's style and paint for it.
    paintFrame();
    expect(usePageSurfaceStore.getState().surface).toBe(
      ONBOARDING_DARK_SURFACE,
    );

    // The next frame, which the dark value is now behind.
    paintFrame();
    expect(usePageSurfaceStore.getState().surface).toBe(TEAL);
    expect(usePageSurfaceStore.getState().transition).toBe(TINT_FADE_CSS);

    unmount();
  });

  test("publishes the tint exactly once, with its fade", () => {
    const steps: string[] = [];
    const stop = usePageSurfaceStore.subscribe((state) =>
      steps.push(`${state.surface}|${state.transition}`),
    );

    const { unmount } = renderScreen();
    paintFrame();
    paintFrame();
    stop();

    expect(steps).toEqual([
      `${ONBOARDING_DARK_SURFACE}|null`,
      `${TEAL}|${TINT_FADE_CSS}`,
    ]);
    unmount();
  });

  test("still darkens the strips while the art is missing", () => {
    // The bundled art is a dynamic import: slow on a restored journey, and on
    // a failed chunk load this screen is what the user sits on for good. A
    // bare fallback would publish nothing and put the pale strip back.
    bundledArt = null;

    const { unmount } = renderScreen();

    expect(usePageSurfaceStore.getState().surface).toBe(
      ONBOARDING_DARK_SURFACE,
    );
    unmount();
  });

  test("releases the surface on unmount", () => {
    const { unmount } = renderScreen();
    paintFrame();
    paintFrame();

    unmount();

    expect(usePageSurfaceStore.getState().surface).toBeNull();
  });
});

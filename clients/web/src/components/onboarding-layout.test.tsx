import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";

let mobile = false;
let electron = false;
let tallEnough = true;

mock.module("@/hooks/use-is-mobile", () => ({
  useIsMobile: () => mobile,
  MOBILE_MEDIA_QUERY: "(max-width: 767px)",
}));
mock.module("@/hooks/use-media-query", () => ({
  // The layout asks exactly one media query of its own: the wrap
  // composition's minimum height.
  useMediaQuery: () => tallEnough,
}));
mock.module("@/runtime/is-electron", () => ({
  isElectron: () => electron,
}));
// The wave is a canvas simulation; the layout's job is only deciding whether
// and in which composition one mounts, so stand in for it with a marker.
mock.module("./avatar-wave", () => ({
  AvatarWave: ({ variant = "column" }: { variant?: string }) => (
    <div data-testid={`wave-${variant}`} />
  ),
  WRAP_WAVE_MIN_HEIGHT_QUERY: "(min-height: 600px)",
}));
mock.module("./creature-footer", () => ({
  CreatureFooter: () => <div data-testid="creature-footer" />,
}));

const { OnboardingLayout } = await import("./onboarding-layout");

afterEach(() => {
  cleanup();
  mobile = false;
  electron = false;
  tallEnough = true;
});

const renderLayout = (
  avatarWave: "none" | "beside" | "around" | undefined = undefined,
) =>
  render(
    <OnboardingLayout avatarWave={avatarWave}>
      <p>step</p>
    </OnboardingLayout>,
  );

describe("OnboardingLayout avatar wave placement", () => {
  test("shows only the creature footer with no wave asked for", () => {
    renderLayout();
    expect(screen.queryByTestId("wave-column")).toBeNull();
    expect(screen.queryByTestId("wave-wrap")).toBeNull();
    expect(screen.getByTestId("creature-footer")).toBeTruthy();
  });

  test("seats `beside` in its own column above the breakpoint", () => {
    renderLayout("beside");
    expect(screen.getByTestId("wave-column")).toBeTruthy();
    expect(screen.queryByTestId("creature-footer")).toBeNull();
  });

  test("falls `beside` back to the footer on a narrow viewport", () => {
    mobile = true;
    renderLayout("beside");
    expect(screen.queryByTestId("wave-column")).toBeNull();
    expect(screen.queryByTestId("wave-wrap")).toBeNull();
    expect(screen.getByTestId("creature-footer")).toBeTruthy();
  });

  test("gives `around` the same column above the breakpoint", () => {
    renderLayout("around");
    expect(screen.getByTestId("wave-column")).toBeTruthy();
    expect(screen.queryByTestId("wave-wrap")).toBeNull();
  });

  test("wraps `around` the content on a narrow viewport, in place of the footer", () => {
    mobile = true;
    renderLayout("around");
    expect(screen.getByTestId("wave-wrap")).toBeTruthy();
    expect(screen.queryByTestId("wave-column")).toBeNull();
    expect(screen.queryByTestId("creature-footer")).toBeNull();
  });

  test("falls `around` back to the footer on a viewport too short to wrap", () => {
    // A phone in landscape: narrow enough to have no column to spare, too
    // short to hold a thread above the content and a crowd below it.
    mobile = true;
    tallEnough = false;
    renderLayout("around");
    expect(screen.queryByTestId("wave-wrap")).toBeNull();
    expect(screen.queryByTestId("wave-column")).toBeNull();
    expect(screen.getByTestId("creature-footer")).toBeTruthy();
  });

  test("keeps a short viewport off the wrap wave, not off the column one", () => {
    // Height only gates the wrap composition; a short desktop window still
    // has a column beside the content.
    tallEnough = false;
    renderLayout("around");
    expect(screen.getByTestId("wave-column")).toBeTruthy();
  });

  test("keeps the desktop shell on the footer either way", () => {
    electron = true;
    for (const placement of ["beside", "around"] as const) {
      renderLayout(placement);
      expect(screen.queryByTestId("wave-column")).toBeNull();
      expect(screen.queryByTestId("wave-wrap")).toBeNull();
      expect(screen.getByTestId("creature-footer")).toBeTruthy();
      cleanup();
    }
  });

  test("isolates the layout so the wrapped wave can sit behind the content", () => {
    mobile = true;
    const { container } = renderLayout("around");
    // Without a stacking context here the wave's negative z-index would drop
    // it behind this element's own background and paint nothing at all.
    expect(container.firstElementChild?.className).toContain("isolate");
  });
});

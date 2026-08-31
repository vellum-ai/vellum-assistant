/**
 * The loading sweep has to survive the design library's `iconOnly` slot.
 *
 * `Button` DROPS `children` when `iconOnly` is set, so an overlay passed as a
 * child reaches the DOM on a labelled control and never on an icon-only one.
 * Both slots are covered here: a sweep that works in one and not the other
 * looks like a working sweep from either side alone.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import { cleanup, render } from "@testing-library/react";

// The design library pulls in tokens and motion; the shimmer itself animates
// via the Web Animations API, which happy-dom does not implement. Stub it to a
// marker so these tests assert MOUNTING, not motion.
mock.module("@/domains/chat/components/shimmer-surface", () => ({
  ShimmerSurface: () => <span data-testid="shimmer-surface" />,
}));

const { SideControlButton } = await import(
  "@/domains/chat/components/side-control-button"
);

afterEach(() => {
  cleanup();
});

describe("SideControlButton loading sweep", () => {
  test("renders the sweep on an ICON-ONLY control", () => {
    const { queryByTestId } = render(
      <SideControlButton
        loading
        aria-label="Progress"
        iconOnly={<svg data-testid="glyph" />}
      />,
    );
    // The regression: `Button` discards children under `iconOnly`, so the
    // sweep has to ride with the glyph instead.
    expect(queryByTestId("shimmer-surface")).not.toBeNull();
    expect(queryByTestId("glyph")).not.toBeNull();
  });

  test("renders the sweep on a control with children", () => {
    const { queryByTestId } = render(
      <SideControlButton loading aria-label="Agents">
        <span data-testid="chips" />
      </SideControlButton>,
    );
    expect(queryByTestId("shimmer-surface")).not.toBeNull();
    expect(queryByTestId("chips")).not.toBeNull();
  });

  test("omits the sweep when not loading, in either slot", () => {
    const iconOnly = render(
      <SideControlButton aria-label="Progress" iconOnly={<svg />} />,
    );
    expect(iconOnly.queryByTestId("shimmer-surface")).toBeNull();
    cleanup();

    const withChildren = render(
      <SideControlButton aria-label="Agents">
        <span />
      </SideControlButton>,
    );
    expect(withChildren.queryByTestId("shimmer-surface")).toBeNull();
  });
});

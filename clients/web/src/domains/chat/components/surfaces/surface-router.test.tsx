import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

// Replace one surface renderer with a component that always throws so we can
// assert the boundary contains the failure. Declared before importing
// `SurfaceRouter` so the mock is in place when the router resolves its imports.
mock.module("@/domains/chat/components/surfaces/card-surface", () => ({
  CardSurface: () => {
    throw new Error("boom");
  },
}));

import { SurfaceRouter } from "@/domains/chat/components/surfaces/surface-router";
import type { Surface } from "@/domains/chat/types/types";

afterEach(() => {
  cleanup();
});

function makeSurface(overrides: Partial<Surface> = {}): Surface {
  return {
    surfaceId: "surface-1",
    surfaceType: "card",
    title: "My App",
    display: "inline",
    data: {},
    ...overrides,
  } as Surface;
}

describe("SurfaceRouter error boundary", () => {
  test("contains a surface render failure behind an inline fallback", () => {
    const { getByRole } = render(<SurfaceRouter surface={makeSurface()} onAction={() => {}} />);

    const alert = getByRole("alert");
    expect(alert.textContent).toContain("My App");
    expect(alert.textContent).toContain("couldn't be displayed");
  });

  test("a crashing surface does not take down a sibling surface", () => {
    const { getByRole, getByText } = render(
      <>
        <SurfaceRouter surface={makeSurface()} onAction={() => {}} />
        <SurfaceRouter
          surface={makeSurface({
            surfaceId: "surface-2",
            surfaceType: "copy_block",
            data: { text: "still here" },
          })}
          onAction={() => {}}
        />
      </>,
    );

    // The card surface is contained…
    expect(getByRole("alert").textContent).toContain("My App");
    // …while the sibling copy_block surface renders normally.
    expect(getByText("still here")).toBeTruthy();
  });
});

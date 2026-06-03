/**
 * Tests for `AppNavBar`.
 *
 * Focuses on the optional fullscreen toggle button: it only renders when an
 * `onToggleFullscreen` callback is supplied, and clicking it invokes that
 * callback. We mount via `@testing-library/react` (backed by happy-dom — see
 * `apps/web/test-setup.ts`).
 *
 * The design-library `Button` renders its tooltip via a Radix tooltip that only
 * adds an accessible name while open, so we locate the fullscreen button by its
 * `Maximize2` glyph (lucide adds a `lucide-maximize2` class to the rendered
 * SVG) rather than by accessible name.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render } from "@testing-library/react";

import { AppNavBar } from "@/components/app-nav-bar";

afterEach(() => {
  cleanup();
});

function getFullscreenButton(): HTMLButtonElement | null {
  const glyph = document.querySelector("svg.lucide-maximize2");
  return glyph?.closest("button") ?? null;
}

describe("AppNavBar fullscreen toggle", () => {
  test("omits the fullscreen button when onToggleFullscreen is not provided", () => {
    render(<AppNavBar appName="My App" onClose={() => {}} />);
    expect(getFullscreenButton()).toBeNull();
  });

  test("renders the fullscreen button and invokes onToggleFullscreen on click", () => {
    const onToggleFullscreen = mock(() => {});
    render(
      <AppNavBar
        appName="My App"
        onClose={() => {}}
        onToggleFullscreen={onToggleFullscreen}
      />,
    );

    const button = getFullscreenButton();
    expect(button).not.toBeNull();

    fireEvent.click(button as HTMLButtonElement);
    expect(onToggleFullscreen).toHaveBeenCalledTimes(1);
  });
});

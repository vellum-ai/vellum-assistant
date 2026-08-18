/**
 * Tests for `useLongPressSheet`: the release of a fired gesture is cancelled so
 * the browser synthesizes no mouse events from it, and the capture-phase guard
 * eats one click for engines that emit one anyway. Every path that closes the
 * sheet has to disarm that guard.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import { useLongPressSheet } from "@/hooks/use-long-press-sheet";

const LONG_PRESS_THRESHOLD_MS = 600;

function setPointerCoarse(coarse: boolean) {
  const original = window.matchMedia;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: mock((query: string) => ({
      matches: coarse && query === "(pointer: coarse)",
      media: query,
      onchange: null,
      addListener: mock(() => {}),
      removeListener: mock(() => {}),
      addEventListener: mock(() => {}),
      removeEventListener: mock(() => {}),
      dispatchEvent: mock(() => false),
    })),
  });
  return () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: original,
    });
  };
}

/**
 * The shape every caller has: the gesture wrapper around a row that owns its
 * own click, with the sheet's state reachable as a sibling of the wrapper.
 */
function Surface({ onSelect }: { onSelect: () => void }) {
  const longPress = useLongPressSheet();

  return (
    <>
      <div data-testid="wrapper" {...longPress.wrapperProps}>
        <button type="button" onClick={onSelect}>
          row
        </button>
      </div>
      <output data-testid="open">{String(longPress.open)}</output>
      <button type="button" onClick={longPress.close}>
        run action
      </button>
      <button type="button" onClick={() => longPress.onOpenChange(false)}>
        dismiss
      </button>
    </>
  );
}

function renderSurface() {
  const onSelect = mock(() => {});
  render(<Surface onSelect={onSelect} />);

  return {
    onSelect,
    wrapper: () => screen.getByTestId("wrapper"),
    row: () => screen.getByRole("button", { name: "row" }),
    isOpen: () => screen.getByTestId("open").textContent === "true",
  };
}

function touchStart(element: Element) {
  fireEvent.touchStart(element, { touches: [{ clientX: 10, clientY: 10 }] });
}

/** `fireEvent` returns `false` when a handler cancelled the event. */
function touchEnd(element: Element): { cancelled: boolean } {
  return { cancelled: !fireEvent.touchEnd(element) };
}

async function holdPastThreshold() {
  await act(async () => {
    await new Promise((resolve) =>
      setTimeout(resolve, LONG_PRESS_THRESHOLD_MS),
    );
  });
}

let restoreMatchMedia: (() => void) | null = null;

beforeEach(() => {
  restoreMatchMedia = setPointerCoarse(true);
});

afterEach(() => {
  cleanup();
  restoreMatchMedia?.();
  restoreMatchMedia = null;
});

describe("useLongPressSheet", () => {
  test("cancels the release of a fired gesture, so it synthesizes no click", async () => {
    const surface = renderSurface();

    touchStart(surface.wrapper());
    await holdPastThreshold();
    expect(surface.isOpen()).toBe(true);

    expect(touchEnd(surface.wrapper()).cancelled).toBe(true);
  });

  test("leaves a plain tap's release alone, so it still selects the row", async () => {
    const surface = renderSurface();

    touchStart(surface.wrapper());
    expect(touchEnd(surface.wrapper()).cancelled).toBe(false);
    expect(surface.isOpen()).toBe(false);

    fireEvent.click(surface.row());
    expect(surface.onSelect).toHaveBeenCalledTimes(1);
  });

  test("swallows a compatibility click that arrives despite the cancellation", async () => {
    const surface = renderSurface();

    touchStart(surface.wrapper());
    await holdPastThreshold();
    touchEnd(surface.wrapper());

    fireEvent.click(surface.row());
    expect(surface.onSelect).not.toHaveBeenCalled();

    // Only the one synthesized click: the guard disarms itself.
    fireEvent.click(surface.row());
    expect(surface.onSelect).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["running an action", "run action"],
    ["dismissing the sheet", "dismiss"],
  ])("%s disarms the guard", async (_name, closeLabel) => {
    const surface = renderSurface();

    touchStart(surface.wrapper());
    await holdPastThreshold();
    touchEnd(surface.wrapper());

    // The compat click, where one exists at all, can be routed to the sheet
    // rather than the wrapper, so closing has to clear the guard itself.
    fireEvent.click(screen.getByRole("button", { name: closeLabel }));
    expect(surface.isOpen()).toBe(false);

    fireEvent.click(surface.row());
    expect(surface.onSelect).toHaveBeenCalledTimes(1);
  });
});

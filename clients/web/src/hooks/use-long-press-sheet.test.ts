/**
 * Tests for `useLongPressSheet` — specifically the compat-click guard, whose
 * whole job is to swallow exactly one synthesized click and then get out of
 * the way. Every path that closes the sheet has to disarm it.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

import { useLongPressSheet } from "@/hooks/use-long-press-sheet";

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

function makeTouchEvent(x: number, y: number) {
  return {
    touches: [{ clientX: x, clientY: y } as Touch],
    target: null,
  } as unknown as React.TouchEvent<HTMLElement>;
}

function makeClickEvent() {
  let defaultPrevented = false;
  return {
    event: {
      preventDefault: () => {
        defaultPrevented = true;
      },
      stopPropagation: () => {},
    } as unknown as React.MouseEvent,
    wasSwallowed: () => defaultPrevented,
  };
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

async function fireLongPress(result: {
  current: ReturnType<typeof useLongPressSheet>;
}) {
  act(() => {
    result.current.wrapperProps.onTouchStart(makeTouchEvent(10, 10));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 600));
  });
  expect(result.current.open).toBe(true);
}

describe("useLongPressSheet compat-click guard", () => {
  test("swallows the compatibility click that follows a long press", async () => {
    const { result } = renderHook(() => useLongPressSheet());
    await fireLongPress(result);

    const first = makeClickEvent();
    act(() => result.current.wrapperProps.onClickCapture(first.event));
    expect(first.wasSwallowed()).toBe(true);

    // Only the one synthesized click — the guard disarms itself.
    const second = makeClickEvent();
    act(() => result.current.wrapperProps.onClickCapture(second.event));
    expect(second.wasSwallowed()).toBe(false);
  });

  test("closing via an action disarms the guard", async () => {
    const { result } = renderHook(() => useLongPressSheet());
    await fireLongPress(result);

    // Running a sheet action closes through `close()`. When the compat click
    // was routed to the sheet rather than the wrapper, the guard is still
    // armed at this point and must be cleared here — otherwise it eats the
    // user's next real tap on the surface.
    act(() => result.current.close());
    expect(result.current.open).toBe(false);

    const next = makeClickEvent();
    act(() => result.current.wrapperProps.onClickCapture(next.event));
    expect(next.wasSwallowed()).toBe(false);
  });

  test("dismissing the sheet disarms the guard", async () => {
    const { result } = renderHook(() => useLongPressSheet());
    await fireLongPress(result);

    act(() => result.current.onOpenChange(false));
    expect(result.current.open).toBe(false);

    const next = makeClickEvent();
    act(() => result.current.wrapperProps.onClickCapture(next.event));
    expect(next.wasSwallowed()).toBe(false);
  });
});

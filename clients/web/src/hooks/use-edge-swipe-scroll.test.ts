import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

import {
  classifyHorizontalDragSurface,
  shouldArmAt,
  useEdgeSwipe,
} from "@/hooks/use-edge-swipe";

let restoreEnvironment: () => void;

beforeEach(() => {
  const matchMedia = window.matchMedia;
  const widthDescriptor = Object.getOwnPropertyDescriptor(window, "innerWidth");
  window.matchMedia = (query) => ({
    matches: query === "(pointer: coarse)",
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 390,
  });
  restoreEnvironment = () => {
    window.matchMedia = matchMedia;
    if (widthDescriptor) {
      Object.defineProperty(window, "innerWidth", widthDescriptor);
    } else {
      Reflect.deleteProperty(window, "innerWidth");
    }
  };
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  restoreEnvironment();
});

function setScrollWidth(element: Element, scrollWidth: number): void {
  // happy-dom does not perform layout, so supply the scrollport's geometry.
  Object.defineProperties(element, {
    clientWidth: { configurable: true, value: 300 },
    scrollWidth: { configurable: true, value: scrollWidth },
  });
}

function tableSurface(overflowX = "auto", scrollWidth = 900) {
  const scroller = document.createElement("div");
  scroller.style.overflowX = overflowX;
  setScrollWidth(scroller, scrollWidth);
  const table = document.createElement("table");
  const cell = table.insertRow().insertCell();
  cell.textContent = "Example cell";
  scroller.appendChild(table);
  document.body.appendChild(scroller);
  return { scroller, cell };
}

function mountGesture(enabled = true) {
  const callbacks = {
    onConfirm: mock(() => {}),
    onMove: mock(() => {}),
    onCommit: mock(() => {}),
    onCancel: mock(() => {}),
  };
  const { unmount } = renderHook(() => useEdgeSwipe({ enabled, ...callbacks }));
  return { ...callbacks, unmount };
}

function touch(
  target: Element,
  type: "touchstart" | "touchmove" | "touchend" | "touchcancel",
  x: number,
  y = 100,
): Event {
  const point = { identifier: 1, clientX: x, clientY: y };
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    touches: {
      value: type === "touchend" || type === "touchcancel" ? [] : [point],
    },
    changedTouches: { value: [point] },
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

function swipe(target: Element, startX = 100): void {
  touch(target, "touchstart", startX);
  touch(target, "touchmove", startX + 30);
  touch(target, "touchmove", startX + 120);
  touch(target, "touchend", startX + 120);
}

describe("horizontal scroll ownership", () => {
  test.each(["auto", "scroll"])(
    "recognizes overflowing %s containers",
    (overflowX) => {
      const { scroller, cell } = tableSurface(overflowX);
      expect(classifyHorizontalDragSurface(scroller)).toBe("scroll");
      expect(classifyHorizontalDragSurface(cell)).toBe("scroll");
      expect(shouldArmAt(10, 390, "scroll")).toBe(false);
      expect(shouldArmAt(100, 390, "scroll")).toBe(false);
    },
  );

  test.each(["hidden", "clip", "visible"])(
    "does not reserve %s overflow",
    (overflowX) => {
      const { cell } = tableSurface(overflowX);
      expect(classifyHorizontalDragSurface(cell)).toBe("none");
    },
  );

  test.each([300, 301])(
    "ignores a %dpx scroll width within rounding tolerance",
    (width) => {
      const { cell } = tableSurface("auto", width);
      expect(classifyHorizontalDragSurface(cell)).toBe("none");
    },
  );

  test("walks through SVG descendants and non-scrolling wrappers", () => {
    const { cell } = tableSurface();
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    svg.appendChild(path);
    cell.appendChild(svg);
    expect(classifyHorizontalDragSurface(path)).toBe("scroll");
  });

  test("gives horizontal scrolling priority over message text", () => {
    const { scroller, cell } = tableSurface();
    scroller.setAttribute("data-message-text", "");
    expect(classifyHorizontalDragSurface(cell)).toBe("scroll");
    setScrollWidth(scroller, 300);
    expect(classifyHorizontalDragSurface(cell)).toBe("text");
  });
});

describe("useEdgeSwipe over scrollable content", () => {
  for (const startX of [10, 100]) {
    test.each([0, 300, 600])(
      `never previews or commits from x=${startX} at scrollLeft=%d`,
      (scrollLeft) => {
        const { scroller, cell } = tableSurface();
        scroller.scrollLeft = scrollLeft;
        const gesture = mountGesture();

        swipe(cell, startX);

        expect(gesture.onConfirm).not.toHaveBeenCalled();
        expect(gesture.onMove).not.toHaveBeenCalled();
        expect(gesture.onCommit).not.toHaveBeenCalled();
      },
    );
  }

  test("leaves browser defaults available while scroll position changes", () => {
    const { scroller, cell } = tableSurface();
    const gesture = mountGesture();
    const start = touch(cell, "touchstart", 100);
    scroller.scrollLeft = 300;
    const move = touch(cell, "touchmove", 220);
    touch(cell, "touchend", 220);

    expect(start.defaultPrevented).toBe(false);
    expect(move.defaultPrevented).toBe(false);
    expect(gesture.onConfirm).not.toHaveBeenCalled();
    expect(gesture.onCommit).not.toHaveBeenCalled();
  });

  test("protects a Markdown table even at the screen edge", () => {
    const { scroller, cell } = tableSurface();
    scroller.setAttribute("data-message-text", "");
    const gesture = mountGesture();

    swipe(cell, 10);

    expect(gesture.onConfirm).not.toHaveBeenCalled();
    expect(gesture.onCommit).not.toHaveBeenCalled();
  });

  test("protects other horizontal scrollers without a table marker", () => {
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    pre.style.overflowX = "auto";
    setScrollWidth(pre, 900);
    pre.appendChild(code);
    document.body.appendChild(pre);
    const gesture = mountGesture();

    swipe(code);

    expect(gesture.onConfirm).not.toHaveBeenCalled();
    expect(gesture.onCommit).not.toHaveBeenCalled();
  });

  test("retains navigation on narrow tables and checks growth on the next touch", () => {
    const { scroller, cell } = tableSurface("auto", 300);
    const gesture = mountGesture();
    swipe(cell);
    expect(gesture.onCommit).toHaveBeenCalledTimes(1);

    setScrollWidth(scroller, 900);
    swipe(cell);
    expect(gesture.onConfirm).toHaveBeenCalledTimes(1);
    expect(gesture.onCommit).toHaveBeenCalledTimes(1);
  });

  test("keeps a rejected touch rejected if its content stops overflowing", () => {
    const { scroller, cell } = tableSurface();
    const gesture = mountGesture();
    touch(cell, "touchstart", 100);
    setScrollWidth(scroller, 300);
    touch(cell, "touchmove", 220);
    touch(cell, "touchend", 220);
    expect(gesture.onConfirm).not.toHaveBeenCalled();

    swipe(cell);
    expect(gesture.onCommit).toHaveBeenCalledTimes(1);
  });

  test("keeps vertical gestures native and cleans up after unmount", () => {
    const { cell } = tableSurface("auto", 300);
    const gesture = mountGesture();
    touch(cell, "touchstart", 100);
    const move = touch(cell, "touchmove", 105, 220);
    touch(cell, "touchend", 105, 220);
    expect(move.defaultPrevented).toBe(false);
    expect(gesture.onCommit).not.toHaveBeenCalled();

    gesture.unmount();
    swipe(cell);
    expect(gesture.onConfirm).not.toHaveBeenCalled();
    expect(gesture.onCommit).not.toHaveBeenCalled();
  });

  test("does not measure ancestors for a start outside the activation band", () => {
    const { cell } = tableSurface();
    const readWidth = mock(() => 0);
    Object.defineProperty(cell, "scrollWidth", { get: readWidth });
    const gesture = mountGesture();

    swipe(cell, 220);

    expect(readWidth).not.toHaveBeenCalled();
    expect(gesture.onCommit).not.toHaveBeenCalled();
  });

  test("does not measure ancestors when the detector is disabled", () => {
    const { cell } = tableSurface();
    const readWidth = mock(() => 0);
    Object.defineProperty(cell, "scrollWidth", { get: readWidth });
    const gesture = mountGesture(false);

    swipe(cell);

    expect(readWidth).not.toHaveBeenCalled();
    expect(gesture.onCommit).not.toHaveBeenCalled();
  });
});

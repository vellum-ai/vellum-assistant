/**
 * Tests for `useIsCompactWidth`.
 *
 * Two things carry weight here. The release band, because the sidebar rail
 * settles on a spring that overshoots its target, so a threshold read straight
 * would flip the layout twice for one toggle. And the render count, because
 * this hook usually watches a surface whose height animates, and a hook that
 * re-rendered on every notification would re-render its consumer on every frame
 * of that animation.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";

import { COMPACT_WIDTH_PX, useIsCompactWidth } from "@/hooks/use-compact-width";

interface StubbedObserver {
  callback: ResizeObserverCallback;
  targets: Set<Element>;
}

const observers = new Set<StubbedObserver>();
let originalResizeObserver: typeof ResizeObserver;

beforeEach(() => {
  observers.clear();
  originalResizeObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    private entry: StubbedObserver;
    constructor(callback: ResizeObserverCallback) {
      this.entry = { callback, targets: new Set() };
      observers.add(this.entry);
    }
    observe(target: Element) {
      this.entry.targets.add(target);
    }
    unobserve(target: Element) {
      this.entry.targets.delete(target);
    }
    disconnect() {
      observers.delete(this.entry);
    }
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  observers.clear();
  globalThis.ResizeObserver = originalResizeObserver;
  document.body.replaceChildren();
});

/**
 * happy-dom has no layout engine, so the box a real browser would measure has
 * to be stubbed onto the element.
 */
function elementOfWidth(width: number): HTMLElement {
  const el = document.createElement("div");
  el.getBoundingClientRect = () => ({ width }) as DOMRect;
  document.body.appendChild(el);
  return el;
}

function resizeTo(width: number): void {
  act(() => {
    for (const observer of observers) {
      for (const target of observer.targets) {
        observer.callback(
          [
            {
              target,
              borderBoxSize: [{ inlineSize: width, blockSize: 0 }],
            } as unknown as ResizeObserverEntry,
          ],
          {} as ResizeObserver,
        );
      }
    }
  });
}

function mount(initialWidth: number) {
  const el = elementOfWidth(initialWidth);
  const ref = { current: el };
  let renders = 0;
  const view = renderHook(() => {
    renders += 1;
    return useIsCompactWidth(ref);
  });
  return { ...view, renderCount: () => renders };
}

describe("useIsCompactWidth", () => {
  test("an element that has not been laid out counts as compact", () => {
    // The roomy layout is the one that has to prove it has room.
    const { result } = mount(0);

    expect(result.current).toBe(true);
  });

  test("a roomy element reads roomy from the first render", () => {
    // Measured in a layout effect, so the first paint is already right rather
    // than flashing the compact layout and correcting.
    const { result, renderCount } = mount(COMPACT_WIDTH_PX * 2);

    expect(result.current).toBe(false);
    expect(renderCount()).toBe(2);
  });

  test("narrowing past the threshold turns compact on", () => {
    const { result } = mount(COMPACT_WIDTH_PX * 2);

    resizeTo(COMPACT_WIDTH_PX - 1);

    expect(result.current).toBe(true);
  });

  test("leaving the compact layout costs more width than entering it did", () => {
    const { result } = mount(0);
    expect(result.current).toBe(true);

    // Past the threshold but still inside the release band, which is where a
    // spring's overshoot lands. Reading the threshold straight here would flip
    // the layout out and back for a single sidebar toggle.
    resizeTo(COMPACT_WIDTH_PX + 1);
    expect(result.current).toBe(true);

    resizeTo(COMPACT_WIDTH_PX + 100);
    expect(result.current).toBe(false);

    // Coming back the other way the threshold itself is the line, so nothing
    // is ever drawn in a box too small for it.
    resizeTo(COMPACT_WIDTH_PX + 1);
    expect(result.current).toBe(false);
    resizeTo(COMPACT_WIDTH_PX - 1);
    expect(result.current).toBe(true);
  });

  test("notifications that do not cross the line do not accumulate renders", () => {
    const { renderCount } = mount(COMPACT_WIDTH_PX * 2);
    const before = renderCount();

    // What a collapsing card sends on every frame it changes height. React
    // re-renders once before it bails out on an unchanged state, so the
    // guarantee is that the cost stops there rather than tracking the
    // notifications.
    for (let i = 0; i < 20; i++) {
      resizeTo(COMPACT_WIDTH_PX * 2);
    }

    expect(renderCount() - before).toBeLessThanOrEqual(1);
  });
});

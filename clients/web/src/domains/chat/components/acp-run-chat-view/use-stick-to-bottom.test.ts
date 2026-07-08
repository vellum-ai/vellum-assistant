/**
 * Unit tests for `useStickToBottom`, the ACP chat view's local
 * stick-to-bottom coordinator.
 *
 * happy-dom has no layout, so `scrollHeight`/`clientHeight`/`scrollTop` are
 * always 0 and the component test can't exercise the scroll math. These tests
 * mount the hook in a tiny harness that attaches its `scrollRef` to a real div,
 * stub that div's layout properties, and dispatch real DOM scroll events so the
 * hook's `addEventListener("scroll", ...)` listener fires exactly as it would
 * on a real gesture.
 *
 * Layout invariant: `distance = scrollHeight - clientHeight - scrollTop`. With
 * `scrollHeight: 5000`, `clientHeight: 800`, the bottom is `scrollTop: 4200`,
 * and the PIN_THRESHOLD is 80px.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { createElement, useState } from "react";

import {
  useStickToBottom,
  type UseStickToBottomReturn,
} from "./use-stick-to-bottom";

/**
 * Stub a div's `scrollTop`/`scrollHeight`/`clientHeight` (happy-dom reports 0).
 * Assigning `scrollTop` records the value so `scrollToLatest`'s
 * `el.scrollTop = el.scrollHeight` is observable.
 */
function stubLayout(
  el: HTMLElement,
  opts: { scrollTop?: number; scrollHeight?: number; clientHeight?: number },
): void {
  let scrollTop = opts.scrollTop ?? 0;
  let scrollHeight = opts.scrollHeight ?? 5000;
  let clientHeight = opts.clientHeight ?? 800;
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (v: number) => {
      scrollTop = v;
    },
  });
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    get: () => scrollHeight,
    set: (v: number) => {
      scrollHeight = v;
    },
  });
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    get: () => clientHeight,
    set: (v: number) => {
      clientHeight = v;
    },
  });
}

/**
 * Mount the hook with its `scrollRef` attached to a real div so the scroll
 * listener binds to that node. Returns the live div plus a getter for the
 * latest hook return (captured each render).
 */
function mountHook(contentKey: unknown): {
  el: HTMLDivElement;
  latest: () => UseStickToBottomReturn;
} {
  let latest: UseStickToBottomReturn | null = null;

  function Harness() {
    const api = useStickToBottom(contentKey);
    latest = api;
    return createElement("div", { ref: api.scrollRef, "data-testid": "scroll" });
  }

  const { container } = render(createElement(Harness));
  const el = container.querySelector(
    "[data-testid=scroll]",
  ) as HTMLDivElement;

  return { el, latest: () => latest as UseStickToBottomReturn };
}

afterEach(() => {
  cleanup();
});

describe("useStickToBottom", () => {
  test("surfaces the scroll-to-latest affordance once the user scrolls up", () => {
    // GIVEN a scroll container pinned to the bottom (distance 0)
    const { el, latest } = mountHook("content-1");
    stubLayout(el, { scrollTop: 4200, scrollHeight: 5000, clientHeight: 800 });

    // WHILE pinned, no affordance is shown
    act(() => {
      el.dispatchEvent(new Event("scroll"));
    });
    expect(latest().showScrollToLatest).toBe(false);

    // WHEN the user scrolls well away from the bottom (distance 4200 > 80)
    act(() => {
      el.scrollTop = 0;
      el.dispatchEvent(new Event("scroll"));
    });

    // THEN the "Go to newest" affordance surfaces
    expect(latest().showScrollToLatest).toBe(true);
  });

  test("scrollToLatest pins to the bottom and clears the affordance", () => {
    // GIVEN a container the user has scrolled up in, with the affordance shown
    const { el, latest } = mountHook("content-1");
    stubLayout(el, { scrollTop: 0, scrollHeight: 5000, clientHeight: 800 });

    act(() => {
      el.dispatchEvent(new Event("scroll"));
    });
    expect(latest().showScrollToLatest).toBe(true);

    // WHEN the user invokes scrollToLatest
    act(() => {
      latest().scrollToLatest();
    });

    // THEN the container is scrolled to the bottom and the flag clears
    expect(el.scrollTop).toBe(5000);
    expect(latest().showScrollToLatest).toBe(false);
  });

  test("re-engages the pin when the user scrolls back to the bottom", () => {
    const { el, latest } = mountHook("content-1");
    stubLayout(el, { scrollTop: 0, scrollHeight: 5000, clientHeight: 800 });

    act(() => {
      el.dispatchEvent(new Event("scroll"));
    });
    expect(latest().showScrollToLatest).toBe(true);

    // WHEN the user scrolls back within the pin threshold (distance 60 <= 80)
    act(() => {
      el.scrollTop = 4140;
      el.dispatchEvent(new Event("scroll"));
    });

    // THEN the affordance hides again
    expect(latest().showScrollToLatest).toBe(false);
  });

  test("rebinds the scroll listener when the conversation node remounts", () => {
    // Mimic the chat view: the scroll div unmounts when a file diff opens and
    // remounts on Back, while the hook itself stays mounted throughout.
    let latest: UseStickToBottomReturn | null = null;
    let setMounted: ((v: boolean) => void) | null = null;

    function Harness() {
      const [mounted, setM] = useState(true);
      setMounted = setM;
      const api = useStickToBottom("content-1");
      latest = api;
      return mounted
        ? createElement("div", { ref: api.scrollRef, "data-testid": "scroll" })
        : createElement("div", { "data-testid": "diff" });
    }

    const { container } = render(createElement(Harness));

    // Unmount the scroll node (open diff), then remount it (Back).
    act(() => setMounted!(false));
    act(() => setMounted!(true));

    const el = container.querySelector(
      "[data-testid=scroll]",
    ) as HTMLDivElement;
    stubLayout(el, { scrollTop: 0, scrollHeight: 5000, clientHeight: 800 });

    // Scrolling the REMOUNTED node must still drive the affordance — the
    // listener has to have rebound to the new node, not the detached one.
    act(() => {
      el.dispatchEvent(new Event("scroll"));
    });
    expect(latest!.showScrollToLatest).toBe(true);
  });

  test("re-pins to the bottom when the content key changes while pinned", () => {
    // The chat view folds terminal state into the content key: the terminal
    // system block renders without a new chat block, so a key change (not just a
    // new `blocks` array) must still re-pin a bottom-pinned user to the latest.
    function Harness({ contentKey }: { contentKey: unknown }) {
      const api = useStickToBottom(contentKey);
      return createElement("div", {
        ref: api.scrollRef,
        "data-testid": "scroll",
      });
    }

    const { container, rerender } = render(
      createElement(Harness, { contentKey: "a" }),
    );
    const el = container.querySelector(
      "[data-testid=scroll]",
    ) as HTMLDivElement;
    // Pinned by default; scrolled to the top so a re-pin is observable.
    stubLayout(el, { scrollTop: 0, scrollHeight: 5000, clientHeight: 800 });

    // A new content key (e.g. the run going terminal) re-pins to the bottom.
    act(() => {
      rerender(createElement(Harness, { contentKey: "b" }));
    });
    expect(el.scrollTop).toBe(5000);
  });
});

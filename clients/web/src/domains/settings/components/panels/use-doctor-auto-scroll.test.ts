/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Tests for the Doctor panel auto-scroll coordinator (`useDoctorAutoScroll`).
 *
 * Pins the coordinator's contract:
 *   1. While pinned to the bottom, streaming growth auto-scrolls.
 *   2. Once the user scrolls away from the bottom, growth stops
 *      auto-scrolling and the "Go to Newest" affordance surfaces.
 *   3. `scrollToLatest()` re-pins and re-engages auto-follow.
 *   4. The scroll listener attaches lazily when the element appears
 *      (the messages div is absent in the idle/loading branches).
 *   5. Pinned state resets when a new scroll element attaches.
 *   6. Catch-up during an active stream keeps auto-follow engaged.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

import { useDoctorAutoScroll } from "./use-doctor-auto-scroll";

// ---------------------------------------------------------------------------
// Fake scroll element — lets the test drive scrollTop/scrollHeight/
// clientHeight directly and records programmatic scrollTo calls so we can
// assert whether auto-follow fired.
// ---------------------------------------------------------------------------

interface RecordedScroll {
  top: number;
  behavior: ScrollBehavior;
}

function createScrollElement(opts: {
  scrollTop?: number;
  scrollHeight?: number;
  clientHeight?: number;
}): { el: HTMLDivElement; scrollToCalls: RecordedScroll[] } {
  const el = document.createElement("div");
  let scrollTop = opts.scrollTop ?? 0;
  let scrollHeight = opts.scrollHeight ?? 5000;
  let clientHeight = opts.clientHeight ?? 800;
  const scrollToCalls: RecordedScroll[] = [];

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
  el.scrollTo = ((target: number | ScrollToOptions) => {
    const optsObj =
      typeof target === "number"
        ? { top: target, behavior: "auto" as ScrollBehavior }
        : { top: target.top ?? 0, behavior: target.behavior ?? "auto" };
    scrollTop = optsObj.top;
    scrollToCalls.push(optsObj);
  }) as typeof el.scrollTo;

  return { el, scrollToCalls };
}

describe("useDoctorAutoScroll", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    cleanup();
  });

  test("auto-scrolls to the bottom while pinned as entries grow", () => {
    // Pinned: scrollTop = maxScrollTop (4200 = 5000 - 800).
    const { el, scrollToCalls } = createScrollElement({
      scrollTop: 4200,
      scrollHeight: 5000,
      clientHeight: 800,
    });
    document.body.appendChild(el);

    const { result, rerender } = renderHook(
      (entries: ReadonlyArray<unknown>) => useDoctorAutoScroll(entries),
      { initialProps: [{}] as ReadonlyArray<unknown> },
    );

    // Attach the element (simulates the messages div mounting once a
    // session starts).
    act(() => {
      result.current.scrollContainerRef(el);
    });

    // Simulate streaming growth: scrollHeight increases as content
    // arrives, viewport stays at the old bottom so it is now above the
    // new bottom.
    act(() => {
      (el as any).scrollHeight = 6000;
      rerender([{}, {}] as ReadonlyArray<unknown>);
    });

    // Pinned → the growth effect should have scrolled to the new bottom.
    const last = scrollToCalls.at(-1);
    expect(last).toBeDefined();
    expect(last!.top).toBe(6000);
  });

  test("stops auto-scrolling once the user scrolls away from the bottom", () => {
    // Start pinned.
    const { el, scrollToCalls } = createScrollElement({
      scrollTop: 4200,
      scrollHeight: 5000,
      clientHeight: 800,
    });
    document.body.appendChild(el);

    const { result, rerender } = renderHook(
      (entries: ReadonlyArray<unknown>) => useDoctorAutoScroll(entries),
      { initialProps: [{}] as ReadonlyArray<unknown> },
    );

    act(() => {
      result.current.scrollContainerRef(el);
    });

    // User drags up — well past the SHOW_SCROLL_BUTTON threshold
    // (distance from bottom = 5000 - 800 - 500 = 3700).
    act(() => {
      el.scrollTop = 500;
      el.dispatchEvent(new Event("scroll"));
    });

    const callsBefore = scrollToCalls.length;

    // Streaming growth arrives while the user is scrolled away.
    act(() => {
      (el as any).scrollHeight = 6000;
      rerender([{}, {}] as ReadonlyArray<unknown>);
    });

    // No auto-scroll should have fired for the growth.
    expect(scrollToCalls.length).toBe(callsBefore);
  });

  test("surfaces the Go to Newest affordance after scrolling away", () => {
    const { el } = createScrollElement({
      scrollTop: 4200,
      scrollHeight: 5000,
      clientHeight: 800,
    });
    document.body.appendChild(el);

    const { result, rerender } = renderHook(
      (entries: ReadonlyArray<unknown>) => useDoctorAutoScroll(entries),
      { initialProps: [{}] as ReadonlyArray<unknown> },
    );

    act(() => {
      result.current.scrollContainerRef(el);
    });
    rerender([{}] as ReadonlyArray<unknown>);

    expect(result.current.showScrollToLatest).toBe(false);

    // Scroll up past the 240 px threshold.
    act(() => {
      el.scrollTop = 3000; // distance from bottom = 1200
      el.dispatchEvent(new Event("scroll"));
    });

    expect(result.current.showScrollToLatest).toBe(true);
  });

  test("scrollToLatest re-pins and re-engages auto-follow", () => {
    // Start scrolled away (un-pinned).
    const { el, scrollToCalls } = createScrollElement({
      scrollTop: 1000,
      scrollHeight: 5000,
      clientHeight: 800,
    });
    document.body.appendChild(el);

    const { result, rerender } = renderHook(
      (entries: ReadonlyArray<unknown>) => useDoctorAutoScroll(entries),
      { initialProps: [{}] as ReadonlyArray<unknown> },
    );

    // Attach while at scrollTop=1000. The growth effect scrolls to the
    // bottom (pinned default is true), so we then simulate the user
    // dragging back up.
    act(() => {
      result.current.scrollContainerRef(el);
    });

    // Confirm we're un-pinned (pill visible). Set scrollTop AFTER attach —
    // the growth effect scrolls to the bottom on attach (pinned default
    // is true), so we simulate the user dragging up here.
    act(() => {
      el.scrollTop = 1000; // distance from bottom = 3200
      el.dispatchEvent(new Event("scroll"));
    });
    expect(result.current.showScrollToLatest).toBe(true);

    // User taps "Go to Newest".
    act(() => {
      result.current.scrollToLatest();
    });
    expect(result.current.showScrollToLatest).toBe(false);

    const callsBefore = scrollToCalls.length;

    // Subsequent streaming growth should auto-follow again.
    act(() => {
      (el as any).scrollHeight = 6000;
      rerender([{}, {}] as ReadonlyArray<unknown>);
    });

    const last = scrollToCalls.at(-1);
    expect(scrollToCalls.length).toBeGreaterThan(callsBefore);
    expect(last!.top).toBe(6000);
  });

  test("listener attaches lazily when the element appears after mount", () => {
    // Element created but NOT attached on first render (idle state).
    const { el } = createScrollElement({
      scrollTop: 4200,
      scrollHeight: 5000,
      clientHeight: 800,
    });
    document.body.appendChild(el);

    const { result, rerender } = renderHook(
      (entries: ReadonlyArray<unknown>) => useDoctorAutoScroll(entries),
      { initialProps: [{}] as ReadonlyArray<unknown> },
    );

    // Before the element attaches, scrolling it should NOT flip the pill
    // (no listener bound). Drive a scroll event and confirm nothing
    // changes.
    act(() => {
      el.scrollTop = 3000; // far from bottom
      el.dispatchEvent(new Event("scroll"));
    });
    expect(result.current.showScrollToLatest).toBe(false);

    // Now the session starts and the messages div mounts.
    act(() => {
      result.current.scrollContainerRef(el);
    });
    rerender([{}] as ReadonlyArray<unknown>);

    // Listener is now bound — dragging up flips the pill.
    act(() => {
      el.scrollTop = 3000; // distance from bottom = 1200
      el.dispatchEvent(new Event("scroll"));
    });
    expect(result.current.showScrollToLatest).toBe(true);
  });

  test("resets pinned state when a new scroll element attaches", () => {    // First transcript — user scrolls away (un-pinned).
    const { el: el1 } = createScrollElement({
      scrollTop: 4200,
      scrollHeight: 5000,
      clientHeight: 800,
    });
    document.body.appendChild(el1);

    const { result, rerender } = renderHook(
      (entries: ReadonlyArray<unknown>) => useDoctorAutoScroll(entries),
      { initialProps: [{}] as ReadonlyArray<unknown> },
    );

    act(() => {
      result.current.scrollContainerRef(el1);
    });
    // Drag up → un-pinned, pill visible.
    act(() => {
      el1.scrollTop = 1000;
      el1.dispatchEvent(new Event("scroll"));
    });
    expect(result.current.showScrollToLatest).toBe(true);

    // Unmount the old element (New Session / assistant switch renders the
    // idle branch).
    act(() => {
      result.current.scrollContainerRef(null);
    });

    // A fresh transcript mounts — new element, scrolled to the bottom.
    const { el: el2 } = createScrollElement({
      scrollTop: 4200,
      scrollHeight: 5000,
      clientHeight: 800,
    });
    document.body.appendChild(el2);
    act(() => {
      result.current.scrollContainerRef(el2);
    });
    rerender([{}, {}] as ReadonlyArray<unknown>);

    // Pinned state should have reset — pill hidden. The growth effect
    // also fires on el2 (auto-follow), but we assert the user-visible
    // contract: the pill is hidden on the fresh transcript.
    expect(result.current.showScrollToLatest).toBe(false);
  });

  test("catch-up during an active stream keeps auto-follow engaged", () => {
    // The regression: a smooth scrollToLatest emits intermediate scroll
    // events >64px from the bottom, which classify() would flip to
    // unpinned before the scroll settles — so a delta landing during the
    // animation skips auto-follow. Instant scrollToLatest has no
    // intermediate events, so the pinned flag stays true and the next
    // delta auto-follows.
    const { el, scrollToCalls } = createScrollElement({
      scrollTop: 4200,
      scrollHeight: 5000,
      clientHeight: 800,
    });
    document.body.appendChild(el);

    const { result, rerender } = renderHook(
      (entries: ReadonlyArray<unknown>) => useDoctorAutoScroll(entries),
      { initialProps: [{}] as ReadonlyArray<unknown> },
    );

    act(() => {
      result.current.scrollContainerRef(el);
    });

    // User scrolls away (un-pinned), pill visible.
    act(() => {
      el.scrollTop = 1000; // distance from bottom = 3200
      el.dispatchEvent(new Event("scroll"));
    });
    expect(result.current.showScrollToLatest).toBe(true);

    // User taps "Go to Newest". scrollToLatest is instant, so no
    // intermediate scroll events fire. Pinned flag stays true.
    act(() => {
      result.current.scrollToLatest();
    });
    expect(result.current.showScrollToLatest).toBe(false);

    const callsBefore = scrollToCalls.length;

    // A streaming delta lands immediately after catch-up. scrollHeight
    // grows; the growth effect should auto-follow because we're pinned.
    act(() => {
      (el as any).scrollHeight = 6000;
      rerender([{}, {}] as ReadonlyArray<unknown>);
    });

    expect(scrollToCalls.length).toBeGreaterThan(callsBefore);
    const last = scrollToCalls.at(-1);
    expect(last!.top).toBe(6000);
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Tests for the Doctor panel auto-scroll coordinator.
 *
 * Regression target: the previous implementation force-scrolled on every
 * streaming `message_delta` with no escape hatch, so on mobile (Android
 * web) the viewport snapped back to the bottom mid-drag with no way to
 * read earlier content until the response finished. These tests pin the
 * new contract:
 *   1. While pinned to the bottom, streaming growth auto-scrolls.
 *   2. Once the user scrolls away from the bottom, growth stops
 *      auto-scrolling and the "Go to Newest" affordance surfaces.
 *   3. `scrollToLatest()` re-pins and re-engages auto-follow.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { createRef } from "react";

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

    const scrollRef = createRef<HTMLDivElement | null>();
    (scrollRef as any).current = el;

    const { rerender } = renderHook(
      (entries: ReadonlyArray<unknown>) => useDoctorAutoScroll(scrollRef, entries),
      { initialProps: [{}] as ReadonlyArray<unknown> },
    );

    // Simulate streaming growth: scrollHeight increases as content arrives,
    // viewport stays at the old bottom so it is now above the new bottom.
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

    const scrollRef = createRef<HTMLDivElement | null>();
    (scrollRef as any).current = el;

    const { rerender } = renderHook(
      (entries: ReadonlyArray<unknown>) => useDoctorAutoScroll(scrollRef, entries),
      { initialProps: [{}] as ReadonlyArray<unknown> },
    );

    // User drags up — well past the SHOW_SCROLL_BUTTON threshold (distance
    // from bottom = 5000 - 800 - 500 = 3700).
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

    // Re-render result exposes showScrollToLatest via the hook return.
    // (We assert behavior indirectly through scrollTo; the pill visibility
    // is React state that we verify in the next test.)
  });

  test("surfaces the Go to Newest affordance after scrolling away", () => {
    const { el } = createScrollElement({
      scrollTop: 4200,
      scrollHeight: 5000,
      clientHeight: 800,
    });
    document.body.appendChild(el);

    const scrollRef = createRef<HTMLDivElement | null>();
    (scrollRef as any).current = el;

    const { result } = renderHook(
      (entries: ReadonlyArray<unknown>) => useDoctorAutoScroll(scrollRef, entries),
      { initialProps: [{}] as ReadonlyArray<unknown> },
    );

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

    const scrollRef = createRef<HTMLDivElement | null>();
    (scrollRef as any).current = el;

    const { result, rerender } = renderHook(
      (entries: ReadonlyArray<unknown>) => useDoctorAutoScroll(scrollRef, entries),
      { initialProps: [{}] as ReadonlyArray<unknown> },
    );

    // Confirm we're un-pinned (pill visible). Set scrollTop AFTER mount —
    // the growth effect scrolls to the bottom on the initial render (the
    // pinned default is true), so we simulate the user dragging up here.
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
});

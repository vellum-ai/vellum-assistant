/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Regression tests for the load-older burst bug.
 *
 * Bug: when the user scrolls to the top, the browser fires many scroll
 * events (~60/sec). Each one was independently calling `onLoadOlder()`
 * because the `isLoadingOlder` prop took a React commit + useEffect to
 * propagate into the hook's `latestRef` mirror — by the time the lock
 * landed, 5–20 events had already fired, overwriting `savedAnchorRef`
 * with progressively different scrollTop values and producing jittery
 * scroll restoration after the prepend.
 *
 * Fix: synchronous `loadOlderInFlightRef` that flips true the moment
 * we fire, gating subsequent triggers within the same gesture, and a
 * mirror useEffect that syncs from the prop on settle.
 *
 * These tests mount the real hook against a fake scroll element and
 * dispatch real DOM scroll events — the pure-function test suite in
 * `use-transcript-scroll.test.ts` cannot catch this class of bug
 * because it never exercises the latestRef commit timing.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { createRef } from "react";

import {
  useTranscriptScroll,
  type UseTranscriptScrollArgs,
} from "./use-transcript-scroll";
import type { TranscriptItem } from "./types";

// ---------------------------------------------------------------------------
// Fake scroll element
// ---------------------------------------------------------------------------
//
// A minimal element that lets the test drive `scrollTop`, `scrollHeight`,
// and `clientHeight` directly. The hook's scroll listener attaches via
// `addEventListener("scroll", ...)`, so dispatchEvent on this element
// routes through the listener exactly as a real scroll gesture would.

function createScrollElement(opts: {
  scrollTop?: number;
  scrollHeight?: number;
  clientHeight?: number;
}): HTMLDivElement {
  const el = document.createElement("div");
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
  return el;
}

function makeMessageItem(key: string): TranscriptItem {
  return {
    key,
    kind: "message",
    message: {
      id: key,
      role: "user",
      content: "x",
      conversationId: "c1",
      createdAt: 0,
    } as any,
  };
}

// ---------------------------------------------------------------------------

describe("useTranscriptScroll — load-older burst regression", () => {
  beforeEach(() => {
    // Make sure each test owns a clean DOM.
    document.body.innerHTML = "";
  });

  afterEach(() => {
    cleanup();
  });

  test("burst of scroll events at the top fires onLoadOlder exactly once", () => {
    let onLoadOlderCalls = 0;
    const scrollEl = createScrollElement({
      scrollTop: 500,
      scrollHeight: 5000,
      clientHeight: 800,
    });
    document.body.appendChild(scrollEl);

    const transcriptRef = createRef<{
      scrollToLatest: (opts?: { behavior?: "auto" | "smooth" }) => void;
      getScrollElement: () => HTMLDivElement | null;
    } | null>();
    (transcriptRef as any).current = {
      scrollToLatest: () => {},
      getScrollElement: () => scrollEl,
    };

    const items: TranscriptItem[] = [
      makeMessageItem("m1"),
      makeMessageItem("m2"),
      makeMessageItem("m3"),
    ];

    const initialArgs: UseTranscriptScrollArgs = {
      transcriptRef: transcriptRef as any,
      items,
      conversationId: "c1",
      hasMore: true,
      isLoadingOlder: false,
      onLoadOlder: () => {
        onLoadOlderCalls += 1;
      },
    };

    renderHook((args: UseTranscriptScrollArgs) => useTranscriptScroll(args), {
      initialProps: initialArgs,
    });

    // Move scrollTop into the load-older window (<= 200 px) and fire
    // a burst of scroll events WITHOUT rerendering the hook. This is the
    // exact pattern that produced the bug: the parent's
    // `setIsLoadingOlder(true)` cannot reach the hook between events.
    act(() => {
      scrollEl.scrollTop = 50;
      for (let i = 0; i < 20; i += 1) {
        scrollEl.dispatchEvent(new Event("scroll"));
      }
    });

    expect(onLoadOlderCalls).toBe(1);
  });

  test("after a settled load (isLoadingOlder true→false), a new burst at the top fires again", () => {
    let onLoadOlderCalls = 0;
    const scrollEl = createScrollElement({
      scrollTop: 500,
      scrollHeight: 5000,
      clientHeight: 800,
    });
    document.body.appendChild(scrollEl);

    const transcriptRef = {
      current: {
        scrollToLatest: () => {},
        getScrollElement: () => scrollEl,
      },
    };

    const items: TranscriptItem[] = [
      makeMessageItem("m1"),
      makeMessageItem("m2"),
    ];

    const { rerender } = renderHook(
      (args: UseTranscriptScrollArgs) => useTranscriptScroll(args),
      {
        initialProps: {
          transcriptRef: transcriptRef as any,
          items,
          conversationId: "c1",
          hasMore: true,
          isLoadingOlder: false,
          onLoadOlder: () => {
            onLoadOlderCalls += 1;
          },
        },
      },
    );

    // First burst → fires once.
    act(() => {
      scrollEl.scrollTop = 50;
      for (let i = 0; i < 10; i += 1) {
        scrollEl.dispatchEvent(new Event("scroll"));
      }
    });
    expect(onLoadOlderCalls).toBe(1);

    // Parent flips isLoadingOlder=true (simulating fetch in flight).
    rerender({
      transcriptRef: transcriptRef as any,
      items,
      conversationId: "c1",
      hasMore: true,
      isLoadingOlder: true,
      onLoadOlder: () => {
        onLoadOlderCalls += 1;
      },
    });

    // Burst while loading → blocked.
    act(() => {
      for (let i = 0; i < 10; i += 1) {
        scrollEl.dispatchEvent(new Event("scroll"));
      }
    });
    expect(onLoadOlderCalls).toBe(1);

    // Page lands: items prepended, isLoadingOlder flips back to false.
    // Scroll restoration would normally bump scrollTop away from the
    // top — simulate that here so the next burst is at the new top.
    const itemsAfterPrepend: TranscriptItem[] = [
      makeMessageItem("m0"),
      ...items,
    ];
    scrollEl.scrollTop = 400; // restored to mid-page
    rerender({
      transcriptRef: transcriptRef as any,
      items: itemsAfterPrepend,
      conversationId: "c1",
      hasMore: true,
      isLoadingOlder: false,
      onLoadOlder: () => {
        onLoadOlderCalls += 1;
      },
    });

    // User scrolls back to the top → a NEW burst should fire onLoadOlder
    // exactly once more (total = 2).
    act(() => {
      scrollEl.scrollTop = 30;
      for (let i = 0; i < 10; i += 1) {
        scrollEl.dispatchEvent(new Event("scroll"));
      }
    });
    expect(onLoadOlderCalls).toBe(2);
  });

  test("failed load (true→false without items change) still releases the lock", () => {
    let onLoadOlderCalls = 0;
    const scrollEl = createScrollElement({
      scrollTop: 50,
      scrollHeight: 5000,
      clientHeight: 800,
    });
    document.body.appendChild(scrollEl);

    const transcriptRef = {
      current: {
        scrollToLatest: () => {},
        getScrollElement: () => scrollEl,
      },
    };

    const items: TranscriptItem[] = [makeMessageItem("m1")];

    const { rerender } = renderHook(
      (args: UseTranscriptScrollArgs) => useTranscriptScroll(args),
      {
        initialProps: {
          transcriptRef: transcriptRef as any,
          items,
          conversationId: "c1",
          hasMore: true,
          isLoadingOlder: false,
          onLoadOlder: () => {
            onLoadOlderCalls += 1;
          },
        },
      },
    );

    act(() => {
      scrollEl.dispatchEvent(new Event("scroll"));
    });
    expect(onLoadOlderCalls).toBe(1);

    // Loading flips on, then back off WITHOUT items changing (fetch
    // failed or returned an empty page). The lock should release so a
    // user-initiated retry can fire.
    rerender({
      transcriptRef: transcriptRef as any,
      items,
      conversationId: "c1",
      hasMore: true,
      isLoadingOlder: true,
      onLoadOlder: () => {
        onLoadOlderCalls += 1;
      },
    });
    rerender({
      transcriptRef: transcriptRef as any,
      items,
      conversationId: "c1",
      hasMore: true,
      isLoadingOlder: false,
      onLoadOlder: () => {
        onLoadOlderCalls += 1;
      },
    });

    act(() => {
      scrollEl.dispatchEvent(new Event("scroll"));
    });
    expect(onLoadOlderCalls).toBe(2);
  });

  test("isLoadingOlder transition without items change does not auto-fire onLoadOlder", () => {
    // Bug repro: parent's `transcriptPagination.isLoadingOlder` mirror
    // useEffect runs at urgent priority while `setMessages` runs inside
    // `startTransition` (in `use-conversation-history.ts`). That can
    // produce an intermediate commit where `isLoadingOlder` transitions
    // true→false BEFORE the older-page items have prepended. The
    // previous items-effect implementation listed `isLoadingOlder` in
    // its dep array, so this intermediate commit re-fired the effect
    // even though items hadn't changed — and the body would:
    //   - release the in-flight lock,
    //   - have `decideItemsChangeAction` return "anchor-correct" on a
    //     key still present in the unchanged list (consuming
    //     `savedAnchorRef` on a heightDelta=0 no-op), and
    //   - re-classify + chain-load fire `onLoadOlder()` again because
    //     the user is still near the top and the lock just released.
    // Result: scrolling to the top loads older pages two-at-a-time.
    //
    // Fix: trim items-effect deps to `[items, conversationId, ...]`
    // only, move the lock-release into its own `useLayoutEffect`
    // keyed on `isLoadingOlder`, and read other mutable values via
    // `latestRef`. An `isLoadingOlder` transition no longer reaches
    // the items-effect at all.
    let onLoadOlderCalls = 0;
    const scrollEl = createScrollElement({
      scrollTop: 30,
      scrollHeight: 5000,
      clientHeight: 800,
    });
    document.body.appendChild(scrollEl);

    const transcriptRef = {
      current: {
        scrollToLatest: () => {},
        getScrollElement: () => scrollEl,
      },
    };

    const items: TranscriptItem[] = [
      makeMessageItem("m1"),
      makeMessageItem("m2"),
    ];

    const onLoadOlder = () => {
      onLoadOlderCalls += 1;
    };

    const { rerender } = renderHook(
      (args: UseTranscriptScrollArgs) => useTranscriptScroll(args),
      {
        initialProps: {
          transcriptRef: transcriptRef as any,
          items,
          conversationId: "c1",
          hasMore: true,
          isLoadingOlder: false,
          onLoadOlder,
        },
      },
    );

    // User scrolls into the load-older window → fires once.
    act(() => {
      scrollEl.dispatchEvent(new Event("scroll"));
    });
    expect(onLoadOlderCalls).toBe(1);

    // Parent flips loading on (mirror useEffect commit).
    rerender({
      transcriptRef: transcriptRef as any,
      items,
      conversationId: "c1",
      hasMore: true,
      isLoadingOlder: true,
      onLoadOlder,
    });

    // Parent flips loading off BEFORE the items have prepended (the
    // urgent vs. transition priority split). scrollTop is still 30 —
    // no anchor restoration could possibly have happened because no
    // items changed. The hook must NOT auto-fire onLoadOlder here.
    rerender({
      transcriptRef: transcriptRef as any,
      items,
      conversationId: "c1",
      hasMore: true,
      isLoadingOlder: false,
      onLoadOlder,
    });

    expect(onLoadOlderCalls).toBe(1);

    // Lock is released → a fresh user-initiated scroll still fires.
    act(() => {
      scrollEl.dispatchEvent(new Event("scroll"));
    });
    expect(onLoadOlderCalls).toBe(2);
  });
});

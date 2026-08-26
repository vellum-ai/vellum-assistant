/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Precedence between the coordinator's layout-driven pins and a text field a
 * transcript row owns.
 *
 * A pin fires only when its observer would otherwise have pinned: the
 * container observer while the thread is pinned to latest, the content
 * observer inside its auto-pin window. Within that, a focused field in the
 * thread wins, and the coordinator asks the transcript handle to keep it on
 * screen instead of scrolling to the latest message. A reader who has scrolled
 * away keeps the viewport they chose, focused field or not.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

import {
  useTranscriptScroll,
  type UseTranscriptScrollArgs,
} from "./use-transcript-scroll";
import type { TranscriptItem } from "./types";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Callbacks of every `ResizeObserver` the hook constructs. */
let observerCallbacks: ResizeObserverCallback[] = [];
let originalResizeObserver: typeof ResizeObserver | undefined;

function installFakeResizeObserver() {
  originalResizeObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) {
      observerCallbacks.push(callback);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

/**
 * Fire every observer the hook installed. A shell resize moves both the
 * container and the content element on a real phone, and mount leaves the
 * auto-pin window open, so both are live here and each contributes one call.
 * Counts below are per observer for that reason.
 */
function fireResize() {
  act(() => {
    for (const callback of observerCallbacks) {
      callback([], {} as ResizeObserver);
    }
  });
}

/** Scroll element whose geometry the test drives directly. Starts pinned to
 *  the bottom (`scrollTop` at max). */
function createScrollElement(): HTMLDivElement {
  const el = document.createElement("div");
  let scrollTop = 4200;
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (v: number) => {
      scrollTop = v;
    },
  });
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    value: 5000,
  });
  Object.defineProperty(el, "clientHeight", { configurable: true, value: 800 });
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

/** Mount the coordinator against a stub handle, so these tests exercise the
 *  `TranscriptHandle` abstraction rather than the DOM behind it.
 *  `focusedField` is what the transcript reports back from
 *  `keepFocusedFieldVisible`; the DOM side is covered in
 *  `focused-field.test.ts`. */
function mountHook(scrollEl: HTMLDivElement, focusedField: boolean) {
  const calls = { scrollToLatest: 0, keepFocusedFieldVisible: 0 };
  const transcriptRef = {
    current: {
      scrollToLatest: () => {
        calls.scrollToLatest += 1;
      },
      keepFocusedFieldVisible: () => {
        calls.keepFocusedFieldVisible += 1;
        return focusedField;
      },
      getScrollElement: () => scrollEl,
      getContentElement: () => scrollEl,
    },
  };

  const args: UseTranscriptScrollArgs = {
    transcriptRef: transcriptRef as any,
    items: [makeMessageItem("m1"), makeMessageItem("m2")],
    conversationId: "c1",
    hasMore: false,
    isLoadingOlder: false,
    onLoadOlder: () => {},
  };

  renderHook((next: UseTranscriptScrollArgs) => useTranscriptScroll(next), {
    initialProps: args,
  });

  // The mount pass pins on its own (conversation-switch reset); every
  // assertion below is about what a later resize does.
  calls.scrollToLatest = 0;
  calls.keepFocusedFieldVisible = 0;
  return calls;
}

/** Drag the thread away from the bottom, the way a reader taking control
 *  does: the touch closes the auto-pin window, the scroll unpins. */
function scrollAwayFromBottom(scrollEl: HTMLDivElement) {
  act(() => {
    scrollEl.dispatchEvent(new Event("touchmove"));
    scrollEl.scrollTop = 1000;
    scrollEl.dispatchEvent(new Event("scroll"));
  });
}

// ---------------------------------------------------------------------------

describe("useTranscriptScroll: focused in-transcript field", () => {
  beforeEach(() => {
    observerCallbacks = [];
    installFakeResizeObserver();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    cleanup();
    if (originalResizeObserver) {
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });

  test("a focused field keeps the viewport instead of pinning to latest", () => {
    const scrollEl = createScrollElement();
    document.body.appendChild(scrollEl);

    const calls = mountHook(scrollEl, true);
    fireResize();

    expect(calls.scrollToLatest).toBe(0);
    expect(calls.keepFocusedFieldVisible).toBe(2);
  });

  test("with no focused field the resize pins to latest", () => {
    const scrollEl = createScrollElement();
    document.body.appendChild(scrollEl);

    const calls = mountHook(scrollEl, false);
    fireResize();

    expect(calls.scrollToLatest).toBe(2);
    expect(calls.keepFocusedFieldVisible).toBe(2);
  });

  test("a reader scrolled away is left alone, focused field or not", () => {
    const scrollEl = createScrollElement();
    document.body.appendChild(scrollEl);

    const calls = mountHook(scrollEl, true);
    scrollAwayFromBottom(scrollEl);
    fireResize();

    expect(calls.scrollToLatest).toBe(0);
    // Never consulted: neither observer would have pinned, so there is no
    // viewport decision for a focused field to win.
    expect(calls.keepFocusedFieldVisible).toBe(0);
  });
});

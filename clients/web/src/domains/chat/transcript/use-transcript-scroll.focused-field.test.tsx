/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Regression tests for the container-resize re-pin stealing an in-transcript
 * field.
 *
 * Bug: the "Connect Claude Code" card renders a paste field inside a
 * transcript row. Tapping it on a phone opens the soft keyboard, which shrinks
 * the app shell, which resizes the transcript's scroll container. The
 * container ResizeObserver then re-pinned to the latest message, scrolling the
 * just-focused field off the top of the viewport, so the field and the
 * keyboard could never be on screen together and the key could not be pasted.
 *
 * Fix: a focused field inside the scroll container outranks the pin.
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

/** Callbacks of every `ResizeObserver` the hook constructs, newest last. */
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
 * auto-pin window open for 500 ms, so both observers are live here and each
 * contributes one call. The counts below are per observer for that reason.
 */
function fireResize() {
  act(() => {
    for (const callback of observerCallbacks) {
      callback([], {} as ResizeObserver);
    }
  });
}

function createScrollElement(): HTMLDivElement {
  const el = document.createElement("div");
  Object.defineProperty(el, "scrollTop", { configurable: true, value: 4200 });
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

function mountHook(scrollEl: HTMLDivElement, contentEl: HTMLDivElement) {
  const scrollToLatestCalls: number[] = [];
  const transcriptRef = {
    current: {
      scrollToLatest: () => {
        scrollToLatestCalls.push(1);
      },
      getScrollElement: () => scrollEl,
      getContentElement: () => contentEl,
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

  // The mount pass pins on its own (conversation-switch reset); the tests
  // assert on what a later resize does.
  scrollToLatestCalls.length = 0;
  return { scrollToLatestCalls };
}

/** An `<input>` inside the transcript, standing in for the Connect card's
 *  paste field. Returns the element plus a record of `scrollIntoView` calls,
 *  which happy-dom does not implement. */
function addFieldTo(parent: HTMLElement) {
  const input = document.createElement("input");
  const scrollIntoViewCalls: ScrollIntoViewOptions[] = [];
  input.scrollIntoView = ((opts?: ScrollIntoViewOptions) => {
    scrollIntoViewCalls.push(opts ?? {});
  }) as HTMLElement["scrollIntoView"];
  parent.appendChild(input);
  return { input, scrollIntoViewCalls };
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

  test("keyboard-driven resize keeps a focused transcript field in view instead of re-pinning", () => {
    const scrollEl = createScrollElement();
    const contentEl = document.createElement("div");
    scrollEl.appendChild(contentEl);
    document.body.appendChild(scrollEl);
    const { input, scrollIntoViewCalls } = addFieldTo(contentEl);

    const { scrollToLatestCalls } = mountHook(scrollEl, contentEl);
    input.focus();
    fireResize();

    expect(scrollToLatestCalls).toHaveLength(0);
    // Once per observer: the container's and the content element's.
    expect(scrollIntoViewCalls).toEqual([
      { block: "nearest", behavior: "auto" },
      { block: "nearest", behavior: "auto" },
    ]);
  });

  test("a focused field outside the transcript (the composer) still re-pins", () => {
    const scrollEl = createScrollElement();
    const contentEl = document.createElement("div");
    scrollEl.appendChild(contentEl);
    document.body.appendChild(scrollEl);
    const composer = document.createElement("div");
    document.body.appendChild(composer);
    const { input } = addFieldTo(composer);

    const { scrollToLatestCalls } = mountHook(scrollEl, contentEl);
    input.focus();
    fireResize();

    expect(scrollToLatestCalls).toHaveLength(2);
  });

  test("with nothing focused the resize re-pins as before", () => {
    const scrollEl = createScrollElement();
    const contentEl = document.createElement("div");
    scrollEl.appendChild(contentEl);
    document.body.appendChild(scrollEl);

    const { scrollToLatestCalls } = mountHook(scrollEl, contentEl);
    fireResize();

    expect(scrollToLatestCalls).toHaveLength(2);
  });
});

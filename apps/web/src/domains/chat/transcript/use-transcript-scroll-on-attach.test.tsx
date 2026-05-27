/**
 * Integration test for `useTranscriptScrollOnAttach`'s load-older
 * wiring. Mounts the hook through real React so the `useEffect` runs
 * against the actual ref-attach lifecycle.
 *
 * Pure-function tests in `transcript-scroll.test.ts` cover
 * `attachLoadOlderOnTop` against a fake DOM. This file proves the
 * effect:
 *   • attaches the observer when refs are populated AND
 *     `hasMore && !isLoadingOlder`,
 *   • tears down + re-attaches when `isLoadingOlder` toggles,
 *   • tears down on unmount.
 *
 * The controller flag is toggled ON via `localStorage` before each
 * test. `transcript-scroll.ts` reads it inside the effect at call
 * time so this is order-independent against other tests.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { cleanup, render } from "@testing-library/react";
import React, { useRef } from "react";

import { useTranscriptScrollOnAttach } from "@/domains/chat/transcript/transcript-scroll";

const STORAGE_KEY = "vellumDebug.flags.transcriptScrollController";

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observed: Element[] = [];
  disconnected = false;
  constructor(public callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }
  observe(el: Element): void {
    this.observed.push(el);
  }
  unobserve(): void {}
  disconnect(): void {
    this.disconnected = true;
  }
  fire(): void {
    this.callback([], this as unknown as ResizeObserver);
  }
}

beforeAll(() => {
  window.localStorage.setItem(STORAGE_KEY, "true");
});
afterAll(() => {
  window.localStorage.removeItem(STORAGE_KEY);
});
beforeEach(() => {
  FakeResizeObserver.instances = [];
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver =
    FakeResizeObserver;
});
afterEach(() => {
  cleanup();
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
});

function Host(props: {
  scrollHeight?: number;
  scrollTop?: number;
  hasMore?: boolean;
  isLoadingOlder?: boolean;
  onLoadOlder?: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const { scrollContainerCallbackRef, contentCallbackRef } =
    useTranscriptScrollOnAttach({
      scrollContainerRef: scrollRef,
      contentRef,
      hasMore: props.hasMore,
      isLoadingOlder: props.isLoadingOlder,
      onLoadOlder: props.onLoadOlder,
    });
  return React.createElement(
    "div",
    {
      ref: (el: HTMLDivElement | null) => {
        if (el) {
          Object.defineProperty(el, "scrollHeight", {
            configurable: true,
            value: props.scrollHeight ?? 5000,
          });
          Object.defineProperty(el, "scrollTop", {
            configurable: true,
            writable: true,
            value: props.scrollTop ?? 0,
          });
        }
        scrollContainerCallbackRef(el);
      },
    },
    React.createElement("div", { ref: contentCallbackRef }),
  );
}

describe("useTranscriptScrollOnAttach — load-older wiring", () => {
  // NOTE: `attachSnapToLatest` (from PR #32239) is gated by the
  // module-load const `TRANSCRIPT_SCROLL_CONTROLLER_ENABLED` which is
  // resolved before any test runs, so it stays off here regardless of
  // the localStorage seed. The new load-older effect reads the flag
  // dynamically via `getTranscriptScrollControllerEnabled()` — that's
  // what the localStorage seed enables. Result: only the load-older
  // observer attaches in these tests, which is what we want to
  // isolate.

  test("does NOT attach observer when hasMore is false", () => {
    render(
      React.createElement(Host, {
        hasMore: false,
        isLoadingOlder: false,
        onLoadOlder: () => {},
      }),
    );
    expect(FakeResizeObserver.instances.length).toBe(0);
  });

  test("does NOT attach observer while isLoadingOlder is true", () => {
    render(
      React.createElement(Host, {
        hasMore: true,
        isLoadingOlder: true,
        onLoadOlder: () => {},
      }),
    );
    expect(FakeResizeObserver.instances.length).toBe(0);
  });

  test("fires onLoadOlder on initial RO tick when at top + hasMore + !isLoadingOlder", () => {
    let calls = 0;
    render(
      React.createElement(Host, {
        hasMore: true,
        isLoadingOlder: false,
        scrollTop: 0,
        onLoadOlder: () => {
          calls += 1;
        },
      }),
    );
    expect(FakeResizeObserver.instances.length).toBe(1);
    FakeResizeObserver.instances[0].fire();
    expect(calls).toBe(1);
  });

  test("tears down + re-attaches when isLoadingOlder toggles", () => {
    let calls = 0;
    const { rerender } = render(
      React.createElement(Host, {
        hasMore: true,
        isLoadingOlder: false,
        scrollTop: 0,
        onLoadOlder: () => {
          calls += 1;
        },
      }),
    );
    expect(FakeResizeObserver.instances.length).toBe(1);
    const initialObserver = FakeResizeObserver.instances[0];

    // Flip isLoadingOlder true — observer should disconnect.
    rerender(
      React.createElement(Host, {
        hasMore: true,
        isLoadingOlder: true,
        scrollTop: 0,
        onLoadOlder: () => {
          calls += 1;
        },
      }),
    );
    expect(initialObserver.disconnected).toBe(true);

    // Flip back — a fresh observer should attach.
    rerender(
      React.createElement(Host, {
        hasMore: true,
        isLoadingOlder: false,
        scrollTop: 0,
        onLoadOlder: () => {
          calls += 1;
        },
      }),
    );
    expect(FakeResizeObserver.instances.length).toBe(2);
    FakeResizeObserver.instances[1].fire();
    expect(calls).toBe(1);
  });

  test("teardown disconnects the observer on unmount", () => {
    const { unmount } = render(
      React.createElement(Host, {
        hasMore: true,
        isLoadingOlder: false,
        scrollTop: 0,
        onLoadOlder: () => {},
      }),
    );
    expect(FakeResizeObserver.instances.length).toBe(1);
    unmount();
    expect(FakeResizeObserver.instances[0].disconnected).toBe(true);
  });
});

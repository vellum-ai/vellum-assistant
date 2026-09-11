import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

import { textBody } from "@/domains/chat/utils/message-test-helpers";

import type { TranscriptHandle } from "./transcript";
import type { TranscriptItem } from "./types";
import {
  useTranscriptScroll,
  type UseTranscriptScrollArgs,
} from "./use-transcript-scroll";

const ORIGINAL_RESIZE_OBSERVER = globalThis.ResizeObserver;
const OBSERVERS = new Set<FixtureResizeObserver>();

class FixtureResizeObserver implements ResizeObserver {
  constructor(private callback: ResizeObserverCallback) {
    OBSERVERS.add(this);
  }
  observe() {}
  unobserve() {}
  disconnect() {
    OBSERVERS.delete(this);
  }
  notify() {
    this.callback([], this);
  }
}

function message(id: string, role: "user" | "assistant"): TranscriptItem {
  return { kind: "message", key: id, message: { id, role, ...textBody(id) } };
}

function harness(isVisible: boolean, items = [message("user-1", "user")]) {
  const element = document.createElement("div");
  const metrics = {
    scrollTop: 4200,
    scrollHeight: 5000,
    clientHeight: 800,
  };
  let visible = isVisible;
  Object.defineProperties(element, {
    scrollTop: {
      get: () => visible ? metrics.scrollTop : 0,
      set: (value: number) => { metrics.scrollTop = value; },
    },
    scrollHeight: { get: () => visible ? metrics.scrollHeight : 0 },
    clientHeight: { get: () => visible ? metrics.clientHeight : 0 },
  });
  const scrollToLatest = mock(() => {
    element.scrollTop = element.scrollHeight - element.clientHeight;
  });
  const onLoadOlder = mock(() => {});
  const handle: TranscriptHandle = {
    scrollToLatest,
    scrollToMessage: () => false,
    keepFocusedFieldVisible: () => false,
    getScrollElement: () => element,
    getContentElement: () => element,
    getViewportHeight: () => element.clientHeight,
    getScrollState: () => ({
      distanceFromBottom: 0,
      isPinned: true,
      showScrollToLatest: false,
      shouldLoadOlder: false,
    }),
  };
  let args: UseTranscriptScrollArgs = {
    transcriptRef: { current: handle },
    items,
    conversationId: "conversation-1",
    hasMore: true,
    isLoadingOlder: false,
    isVisible,
    onLoadOlder,
  };
  const hook = renderHook(useTranscriptScroll, { initialProps: args });
  scrollToLatest.mockClear();
  return {
    ...hook,
    element,
    metrics,
    scrollToLatest,
    onLoadOlder,
    rerender(patch: Partial<UseTranscriptScrollArgs>) {
      args = { ...args, ...patch };
      visible = args.isVisible ?? true;
      hook.rerender(args);
    },
    scrollTo(top: number) {
      act(() => {
        element.dispatchEvent(new Event("touchmove"));
        element.scrollTop = top;
        element.dispatchEvent(new Event("scroll"));
      });
    },
  };
}

function notifyResize() {
  act(() => {
    for (const observer of OBSERVERS) {
      observer.notify();
    }
  });
}

describe("useTranscriptScroll: hidden document presentation", () => {
  beforeEach(() => {
    globalThis.ResizeObserver = FixtureResizeObserver;
  });
  afterEach(() => {
    cleanup();
    OBSERVERS.clear();
    globalThis.ResizeObserver = ORIGINAL_RESIZE_OBSERVER;
  });

  test("does not page or pin while mounted with hidden geometry", () => {
    const fixture = harness(false);
    fixture.rerender({
      items: [message("user-1", "user"), message("assistant-1", "assistant")],
    });
    notifyResize();
    act(() => fixture.element.dispatchEvent(new Event("scroll")));
    expect(fixture.onLoadOlder).not.toHaveBeenCalled();
    expect(fixture.scrollToLatest).not.toHaveBeenCalled();
  });

  test("keeps the reader's older position through hidden response updates", () => {
    const fixture = harness(true);
    fixture.scrollTo(1200);
    expect(fixture.result.current.showScrollToLatest).toBe(true);
    fixture.rerender({ isVisible: false });
    fixture.rerender({
      items: [message("user-1", "user"), message("assistant-1", "assistant")],
    });
    notifyResize();
    expect(fixture.result.current.showScrollToLatest).toBe(true);
    expect(fixture.onLoadOlder).not.toHaveBeenCalled();
    expect(fixture.scrollToLatest).not.toHaveBeenCalled();

    fixture.rerender({ isVisible: true });
    notifyResize();
    expect(fixture.metrics.scrollTop).toBe(1200);
    expect(fixture.scrollToLatest).not.toHaveBeenCalled();
    expect(fixture.result.current.showScrollToLatest).toBe(true);
  });

  test("initial hidden assistant-only history lands at latest when revealed", async () => {
    const fixture = harness(false, [message("assistant-1", "assistant")]);
    await new Promise((resolve) => setTimeout(resolve, 550));
    fixture.metrics.scrollTop = 0;
    fixture.rerender({ isVisible: true });
    expect(fixture.metrics.scrollTop).toBe(4200);
    expect(fixture.scrollToLatest).toHaveBeenCalled();
  });

  test("defers a pending older-page anchor correction until reveal", () => {
    const fixture = harness(true);
    fixture.scrollTo(50);
    expect(fixture.onLoadOlder).toHaveBeenCalledTimes(1);
    fixture.rerender({ isVisible: false, isLoadingOlder: true });
    fixture.metrics.scrollHeight = 6000;
    fixture.rerender({
      isLoadingOlder: false,
      items: [message("older-1", "assistant"), message("user-1", "user")],
    });
    expect(fixture.metrics.scrollTop).toBe(50);
    expect(fixture.onLoadOlder).toHaveBeenCalledTimes(1);

    fixture.rerender({ isVisible: true });
    expect(fixture.metrics.scrollTop).toBe(1050);
    expect(fixture.onLoadOlder).toHaveBeenCalledTimes(1);
  });

  test("pins a new send on reveal without scrolling the hidden element", () => {
    const fixture = harness(true);
    fixture.scrollTo(1200);
    fixture.rerender({ isVisible: false });
    act(() => fixture.result.current.scrollToLatest());
    fixture.rerender({
      items: [message("user-1", "user"), message("user-2", "user")],
    });
    expect(fixture.scrollToLatest).not.toHaveBeenCalled();
    fixture.rerender({ isVisible: true });
    expect(fixture.metrics.scrollTop).toBe(4200);
    expect(fixture.scrollToLatest).toHaveBeenCalled();
  });
});

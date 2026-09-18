import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

import type { DisplayMessage } from "@/domains/chat/types/types";

import { buildTranscriptItems } from "./build-items";
import type { TranscriptHandle } from "./transcript";
import {
  useTranscriptScroll,
  type UseTranscriptScrollArgs,
} from "./use-transcript-scroll";

const originalResizeObserver = globalThis.ResizeObserver;
let resizeCallbacks: (() => void)[];

beforeEach(() => {
  resizeCallbacks = [];
  globalThis.ResizeObserver = class implements ResizeObserver {
    constructor(private callback: ResizeObserverCallback) {}
    observe() {
      resizeCallbacks.push(() => this.callback([], this));
    }
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
  cleanup();
  globalThis.ResizeObserver = originalResizeObserver;
});

const frames: DisplayMessage[] = ["f1", "f2", "f3", "f4"].map((id) => ({
  id,
  role: "user",
  isCameraFrame: true,
}));
function project(messages: DisplayMessage[]) {
  return buildTranscriptItems({
    messages,
    pendingSecret: null,
    pendingConfirmation: null,
    isThinking: false,
  });
}

function createHarness(
  initialMessages = frames.slice(2),
  initialHeight = 1800,
) {
  let renderedMessages = initialMessages;
  const scrollElement = document.createElement("div");
  const contentElement = document.createElement("div");
  scrollElement.append(contentElement);
  Object.defineProperty(scrollElement, "scrollHeight", {
    configurable: true,
    value: initialHeight,
  });
  Object.defineProperty(scrollElement, "clientHeight", {
    configurable: true,
    value: 800,
  });
  const scrollToLatest = mock(() => {
    scrollElement.scrollTop = Math.max(
      0,
      scrollElement.scrollHeight - scrollElement.clientHeight,
    );
  });
  const handle: TranscriptHandle = {
    scrollToLatest,
    scrollToMessage: () => false,
    keepFocusedFieldVisible: () => false,
    getScrollElement: () => scrollElement,
    getContentElement: () => contentElement,
    getViewportHeight: () => 800,
    getRenderedMessageIds: () => renderedMessages.map((message) => message.id),
    getScrollState: () => ({
      distanceFromBottom: 0,
      isPinned: false,
      showScrollToLatest: false,
      shouldLoadOlder: false,
    }),
  };
  const onLoadOlder = mock();
  const initialProps: UseTranscriptScrollArgs = {
    transcriptRef: { current: handle },
    conversationId: "conv-123",
    items: project(initialMessages),
    hasMore: false,
    isLoadingOlder: false,
    onLoadOlder,
  };
  const hook = renderHook(
    (props: UseTranscriptScrollArgs) => useTranscriptScroll(props),
    { initialProps },
  );
  hook.rerender({ ...initialProps, hasMore: true });
  act(() => {
    scrollElement.scrollTop = Math.min(
      100,
      Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight),
    );
    scrollElement.dispatchEvent(new Event("scroll"));
  });
  expect(onLoadOlder).toHaveBeenCalledTimes(1);
  hook.rerender({ ...initialProps, hasMore: true, isLoadingOlder: true });
  scrollToLatest.mockClear();
  return {
    ...hook,
    scrollElement,
    scrollToLatest,
    onLoadOlder,
    update(
      messages: DisplayMessage[],
      isLoadingOlder = false,
      scrollHeight = 2300,
      hasMore = false,
    ) {
      renderedMessages = messages;
      Object.defineProperty(scrollElement, "scrollHeight", {
        configurable: true,
        value: scrollHeight,
      });
      hook.rerender({
        ...initialProps,
        items: project(messages),
        isLoadingOlder,
        hasMore,
      });
    },
  };
}

describe("camera frame pagination scrolling", () => {
  test("chain-loads frames folded into an unchanged host, then stops on no progress or hydration", () => {
    const utterance: DisplayMessage = { id: "speech", role: "user" };
    const harness = createHarness([...frames.slice(2), utterance], 400);
    const firstPage = [...frames.slice(1), utterance];
    expect(project(firstPage).map((item) => item.key)).toEqual(["speech"]);

    harness.update(firstPage, false, 450, true);
    expect(harness.onLoadOlder).toHaveBeenCalledTimes(2);

    harness.update(firstPage, true, 450, true);
    harness.update([...frames, utterance], false, 500, true);
    expect(harness.onLoadOlder).toHaveBeenCalledTimes(3);

    harness.update([...frames, utterance], true, 500, true);
    const unchanged = [...frames, utterance].map((message) => ({ ...message }));
    harness.update(unchanged, false, 500, true);
    expect(harness.onLoadOlder).toHaveBeenCalledTimes(3);

    harness.update(
      [
        {
          ...frames[0]!,
          attachments: [
            {
              id: "attachment-1",
              filename: "frame.png",
              mimeType: "image/png",
              sizeBytes: 1,
              previewUrl: "https://example.com/frame.png",
            },
          ],
        },
        ...frames.slice(1),
        utterance,
      ],
      false,
      500,
      true,
    );
    expect(harness.onLoadOlder).toHaveBeenCalledTimes(3);
  });

  test.each([false, true])(
    "hydration while loading preserves the saved anchor for the actual prepend (utterance: %j)",
    (withUtterance) => {
      const utterance: DisplayMessage = { id: "speech", role: "user" };
      const tail = withUtterance ? [utterance] : [];
      const harness = createHarness([...frames.slice(2), ...tail]);
      const hydrated: DisplayMessage = {
        ...frames[2]!,
        attachments: [
          {
            id: "att-3",
            filename: "frame.png",
            mimeType: "image/png",
            sizeBytes: 1,
            previewUrl: null,
          },
        ],
      };
      harness.update([hydrated, frames[3]!, ...tail], true, 1800);
      expect(harness.scrollElement.scrollTop).toBe(100);
      expect(harness.scrollToLatest).not.toHaveBeenCalled();
      harness.update([frames[0]!, frames[1]!, hydrated, frames[3]!, ...tail]);
      expect(harness.scrollElement.scrollTop).toBe(600);
      expect(harness.scrollToLatest).not.toHaveBeenCalled();
    },
  );

  test.each(["into", "above"])(
    "preserves the viewport when paging %s the latest frame group",
    (location) => {
      const harness = createHarness();
      const messages =
        location === "into"
          ? frames
          : [{ id: "older", role: "assistant" as const }, ...frames.slice(2)];
      harness.update(messages);
      expect(harness.scrollElement.scrollTop).toBe(600);
      expect(harness.scrollToLatest).not.toHaveBeenCalled();
      act(() => {
        for (const resize of resizeCallbacks) {
          resize();
        }
      });
      expect(harness.scrollToLatest).not.toHaveBeenCalled();
      expect(harness.scrollElement.scrollTop).toBe(600);
    },
  );

  test.each([false, true])(
    "a genuine utterance rehosting the frames pins even during pagination (loading: %j)",
    (isLoadingOlder) => {
      const harness = createHarness();
      harness.update(
        [...frames, { id: "speech", role: "user" }],
        isLoadingOlder,
      );
      expect(harness.scrollToLatest).toHaveBeenCalled();
      expect(harness.scrollElement.scrollTop).toBe(1500);
      const count = harness.scrollToLatest.mock.calls.length;
      act(() => {
        for (const resize of resizeCallbacks) {
          resize();
        }
      });
      expect(harness.scrollToLatest.mock.calls.length).toBeGreaterThan(count);
    },
  );

  test("a distinct new user turn still pins when older frames arrive in the same update", () => {
    const harness = createHarness();
    harness.update([
      ...frames,
      { id: "response", role: "assistant" },
      { id: "new-submit", role: "user" },
    ]);
    expect(harness.scrollToLatest).toHaveBeenCalled();
    expect(harness.scrollElement.scrollTop).toBe(1500);
  });

  test("a keep appended during pagination preserves the same run and viewport", () => {
    const harness = createHarness();
    harness.update([
      ...frames,
      { id: "f5", role: "user", isCameraFrame: true },
    ]);
    expect(harness.scrollElement.scrollTop).toBe(600);
    expect(harness.scrollToLatest).not.toHaveBeenCalled();
    act(() => {
      for (const resize of resizeCallbacks) {
        resize();
      }
    });
    expect(harness.scrollToLatest).not.toHaveBeenCalled();
  });
});

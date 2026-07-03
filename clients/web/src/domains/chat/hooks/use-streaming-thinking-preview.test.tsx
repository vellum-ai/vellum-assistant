import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

import {
  firstSentenceOfLatestThinkingParagraph,
  useStreamingThinkingPreview,
} from "@/domains/chat/hooks/use-streaming-thinking-preview";

const START = 1_700_000_000_000;
const EXPECTED_PREVIEW_UPDATE_INTERVAL_MS = 2_000;

interface TimeoutHandle {
  id: number;
  fn: () => void;
  ms: number;
  cleared: boolean;
}

let timeouts: TimeoutHandle[] = [];
let nextTimeoutId = 1;
let originalSetTimeout: typeof globalThis.setTimeout;
let originalClearTimeout: typeof globalThis.clearTimeout;

beforeEach(() => {
  timeouts = [];
  nextTimeoutId = 1;
  setSystemTime(new Date(START));
  originalSetTimeout = globalThis.setTimeout;
  originalClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = ((
    fn: (...args: unknown[]) => void,
    ms?: number,
  ) => {
    const handle: TimeoutHandle = {
      id: nextTimeoutId++,
      fn: () => fn(),
      ms: ms ?? 0,
      cleared: false,
    };
    timeouts.push(handle);
    return handle.id as unknown as ReturnType<typeof globalThis.setTimeout>;
  }) as typeof globalThis.setTimeout;
  globalThis.clearTimeout = ((id?: number) => {
    const handle = timeouts.find((h) => h.id === id);
    if (handle) handle.cleared = true;
  }) as typeof globalThis.clearTimeout;
});

afterEach(() => {
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
  cleanup();
  setSystemTime();
});

function pendingTimeouts() {
  return timeouts.filter((h) => !h.cleared);
}

function firePendingTimers() {
  for (const handle of pendingTimeouts()) {
    handle.cleared = true;
    act(() => {
      handle.fn();
    });
  }
}

describe("firstSentenceOfLatestThinkingParagraph", () => {
  test("returns the first sentence from the latest non-empty paragraph", () => {
    expect(
      firstSentenceOfLatestThinkingParagraph(
        "Earlier paragraph should not show. It has details.\n\nI should inspect the route first. Then write the fix.",
      ),
    ).toBe("I should inspect the route first.");
  });

  test("returns null until the latest paragraph streams a period", () => {
    expect(
      firstSentenceOfLatestThinkingParagraph(
        "Complete prior thought.\n\nStill forming the latest idea",
      ),
    ).toBeNull();
    expect(firstSentenceOfLatestThinkingParagraph("I")).toBeNull();
  });

  test("parses through the first period in the latest paragraph", () => {
    expect(
      firstSentenceOfLatestThinkingParagraph(
        "Complete prior thought.\n\nWhy? Because this is enough. Later sentence.",
      ),
    ).toBe("Why? Because this is enough.");
  });

  test("does not stop at periods inside dotted identifiers", () => {
    expect(
      firstSentenceOfLatestThinkingParagraph(
        "I need to check v2.0 of config.json before acting. Then continue.",
      ),
    ).toBe("I need to check v2.0 of config.json before acting.");
  });

  test("returns null for question-only paragraphs without a period", () => {
    expect(
      firstSentenceOfLatestThinkingParagraph(
        "What should I check? Where is the bug?",
      ),
    ).toBeNull();
  });

  test("returns null for blank thinking text", () => {
    expect(firstSentenceOfLatestThinkingParagraph("\n\n  ")).toBeNull();
  });
});

describe("useStreamingThinkingPreview", () => {
  test("throttles preview changes to at most once every two seconds", () => {
    const { result, rerender } = renderHook(
      ({ content }) => useStreamingThinkingPreview(content, true),
      {
        initialProps: {
          content: "First visible thought.",
        },
      },
    );

    expect(result.current).toBe("First visible thought.");

    setSystemTime(new Date(START + 1_000));
    rerender({ content: "Second visible thought. More detail follows." });

    expect(result.current).toBe("First visible thought.");
    expect(pendingTimeouts()).toHaveLength(1);
    expect(pendingTimeouts()[0]!.ms).toBe(
      EXPECTED_PREVIEW_UPDATE_INTERVAL_MS - 1_000,
    );

    setSystemTime(new Date(START + EXPECTED_PREVIEW_UPDATE_INTERVAL_MS));
    firePendingTimers();

    expect(result.current).toBe("Second visible thought.");
  });

  test("uses the latest pending preview when more tokens arrive before the throttle fires", () => {
    const { result, rerender } = renderHook(
      ({ content }) => useStreamingThinkingPreview(content, true),
      {
        initialProps: {
          content: "First visible thought.",
        },
      },
    );

    setSystemTime(new Date(START + 500));
    rerender({ content: "Second visible thought." });
    setSystemTime(new Date(START + 1_000));
    rerender({
      content:
        "Second visible thought.\n\nNewest paragraph should win. Later sentence.",
    });

    expect(result.current).toBe("First visible thought.");
    expect(pendingTimeouts()).toHaveLength(1);
    expect(pendingTimeouts()[0]!.ms).toBe(
      EXPECTED_PREVIEW_UPDATE_INTERVAL_MS - 1_000,
    );

    setSystemTime(new Date(START + EXPECTED_PREVIEW_UPDATE_INTERVAL_MS));
    firePendingTimers();

    expect(result.current).toBe("Newest paragraph should win.");
  });

  test("keeps the current preview while the latest paragraph has no period", () => {
    const { result, rerender } = renderHook(
      ({ content }) => useStreamingThinkingPreview(content, true),
      {
        initialProps: {
          content: "First visible thought.",
        },
      },
    );

    expect(result.current).toBe("First visible thought.");

    setSystemTime(new Date(START + 1_000));
    rerender({ content: "First visible thought.\n\nI" });

    expect(result.current).toBe("First visible thought.");
    expect(pendingTimeouts()).toHaveLength(0);

    setSystemTime(new Date(START + 1_500));
    rerender({
      content: "First visible thought.\n\nNext paragraph is ready. More detail.",
    });

    expect(result.current).toBe("First visible thought.");
    expect(pendingTimeouts()).toHaveLength(1);
    expect(pendingTimeouts()[0]!.ms).toBe(
      EXPECTED_PREVIEW_UPDATE_INTERVAL_MS - 1_500,
    );

    setSystemTime(new Date(START + EXPECTED_PREVIEW_UPDATE_INTERVAL_MS));
    firePendingTimers();

    expect(result.current).toBe("Next paragraph is ready.");
  });
});

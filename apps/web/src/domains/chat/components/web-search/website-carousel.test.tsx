/**
 * Tests for `WebsiteCarousel`.
 *
 * bun:test doesn't ship a `vi.useFakeTimers()` equivalent, so we drive the
 * carousel's `setInterval` manually by monkey-patching the global. Each test
 * captures the callback the component registers, then invokes it from `act()`
 * to advance the rotation without real-time delays.
 *
 * The reduced-motion path is verified by stubbing `motion/react` so that
 * `useReducedMotion()` returns `true` and `motion.div` resolves to a plain
 * `<div>` that strips animation-only props — this lets us assert on the
 * static DOM that no `y` transform leaked through.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";

import { cleanup, render } from "@testing-library/react";

import { WebsiteCarousel } from "@/domains/chat/components/web-search/website-carousel";

// ---------------------------------------------------------------------------
// setInterval harness
// ---------------------------------------------------------------------------

interface IntervalHandle {
  id: number;
  fn: () => void;
  ms: number;
  cleared: boolean;
}

let intervals: IntervalHandle[] = [];
let nextIntervalId = 1;
let setIntervalCallCount = 0;
let originalSetInterval: typeof globalThis.setInterval;
let originalClearInterval: typeof globalThis.clearInterval;

beforeEach(() => {
  intervals = [];
  nextIntervalId = 1;
  setIntervalCallCount = 0;
  originalSetInterval = globalThis.setInterval;
  originalClearInterval = globalThis.clearInterval;
  globalThis.setInterval = ((
    fn: (...args: unknown[]) => void,
    ms?: number,
  ) => {
    setIntervalCallCount += 1;
    const handle: IntervalHandle = {
      id: nextIntervalId++,
      fn: () => fn(),
      ms: ms ?? 0,
      cleared: false,
    };
    intervals.push(handle);
    return handle.id as unknown as ReturnType<typeof globalThis.setInterval>;
  }) as typeof globalThis.setInterval;
  globalThis.clearInterval = ((id: number) => {
    const handle = intervals.find((h) => h.id === id);
    if (handle) handle.cleared = true;
  }) as typeof globalThis.clearInterval;
});

afterEach(() => {
  globalThis.setInterval = originalSetInterval;
  globalThis.clearInterval = originalClearInterval;
  cleanup();
});

/** Fire every pending (non-cleared) interval one tick. */
function advanceOneTick() {
  for (const handle of intervals) {
    if (!handle.cleared) {
      act(() => {
        handle.fn();
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const ITEMS = [
  { faviconUrl: "https://a.test/favicon.ico", title: "Alpha", domain: "a.test" },
  { faviconUrl: "https://b.test/favicon.ico", title: "Bravo", domain: "b.test" },
  { faviconUrl: "https://c.test/favicon.ico", title: "Charlie", domain: "c.test" },
];

describe("WebsiteCarousel — rotation", () => {
  test("advances to the next item after the interval fires", () => {
    const { getByText } = render(
      <WebsiteCarousel items={ITEMS} intervalMs={1000} />,
    );
    // Initial frame shows the first item.
    expect(getByText("Alpha")).toBeTruthy();
    // After one interval tick → second item visible.
    advanceOneTick();
    expect(getByText("Bravo")).toBeTruthy();
    // After two ticks → third item visible (interval * 2 worth of progress).
    // Note: `AnimatePresence mode="popLayout"` retains the previous element
    // during its exit animation, so we only assert that the new entry is in
    // the tree — the old one may still be there mid-fade.
    advanceOneTick();
    expect(getByText("Charlie")).toBeTruthy();
  });

  test("wraps back to the first item after the last", () => {
    const { getByText } = render(
      <WebsiteCarousel items={ITEMS} intervalMs={500} />,
    );
    advanceOneTick(); // Bravo
    advanceOneTick(); // Charlie
    advanceOneTick(); // Alpha again
    expect(getByText("Alpha")).toBeTruthy();
  });

  test("uses the supplied intervalMs when scheduling", () => {
    render(<WebsiteCarousel items={ITEMS} intervalMs={1234} />);
    expect(intervals).toHaveLength(1);
    expect(intervals[0]!.ms).toBe(1234);
  });
});

describe("WebsiteCarousel — degenerate cases", () => {
  test("with one item: renders it statically and never schedules an interval", () => {
    const { getByText } = render(
      <WebsiteCarousel items={[ITEMS[0]!]} intervalMs={500} />,
    );
    expect(getByText("Alpha")).toBeTruthy();
    expect(setIntervalCallCount).toBe(0);
  });

  test("with zero items: renders nothing and never schedules an interval", () => {
    const { container } = render(<WebsiteCarousel items={[]} />);
    expect(container.firstChild).toBeNull();
    expect(setIntervalCallCount).toBe(0);
  });

  test("clears its interval on unmount", () => {
    const { unmount } = render(
      <WebsiteCarousel items={ITEMS} intervalMs={500} />,
    );
    expect(intervals).toHaveLength(1);
    unmount();
    expect(intervals[0]!.cleared).toBe(true);
  });
});

describe("WebsiteCarousel — layout shell", () => {
  test("wrapper uses fixed 28px height and overflow hidden", () => {
    const { container } = render(<WebsiteCarousel items={ITEMS} />);
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).toContain("h-[28px]");
    expect(wrapper.className).toContain("overflow-hidden");
    expect(wrapper.className).toContain("relative");
  });
});

// ---------------------------------------------------------------------------
// Reduced-motion path — verified by stubbing `motion/react`.
// ---------------------------------------------------------------------------

describe("WebsiteCarousel — reduced motion", () => {
  afterEach(() => {
    mock.restore();
  });

  test("renders without a y transform when prefers-reduced-motion is set", async () => {
    // Capture the props passed to motion.div so we can assert that the y-axis
    // offset has been zeroed out in the reduced-motion branch.
    const motionDivCalls: Array<Record<string, unknown>> = [];
    mock.module("motion/react", () => {
      const motionDiv = ({
        children,
        animate,
        initial,
        exit,
        transition,
        ...rest
      }: {
        children?: React.ReactNode;
        animate?: Record<string, unknown>;
        initial?: Record<string, unknown>;
        exit?: Record<string, unknown>;
        transition?: Record<string, unknown>;
        [key: string]: unknown;
      }) => {
        motionDivCalls.push({ animate, initial, exit, transition });
        return <div {...rest}>{children}</div>;
      };
      // The mock module bleeds across files in the same `bun test` run, so
      // also stub `motion.span` (used by `WebSearchProgressCard`'s header
      // carousel) — otherwise downstream suites that touch that card render
      // `undefined` and crash. Span is rendered as a passthrough since the
      // y-offset assertion only inspects `motion.div`.
      const motionSpan = ({
        children,
        ...rest
      }: {
        children?: React.ReactNode;
        [key: string]: unknown;
      }) => <span {...rest}>{children}</span>;
      return {
        motion: { div: motionDiv, span: motionSpan },
        AnimatePresence: ({ children }: { children?: React.ReactNode }) => (
          <>{children}</>
        ),
        useReducedMotion: () => true,
      };
    });

    const { WebsiteCarousel: PatchedCarousel } = await import(
      "./website-carousel"
    );
    render(<PatchedCarousel items={ITEMS} intervalMs={500} />);

    // At least one motion.div should have been rendered.
    expect(motionDivCalls.length).toBeGreaterThan(0);
    const props = motionDivCalls[0]!;
    // The reduced-motion branch must drop the y offsets — opacity-only fade.
    expect((props.initial as Record<string, unknown>).y).toBeUndefined();
    expect((props.animate as Record<string, unknown>).y).toBeUndefined();
    expect((props.exit as Record<string, unknown>).y).toBeUndefined();
    // Transition collapses to an instantaneous 0-duration fade.
    expect((props.transition as Record<string, unknown>).duration).toBe(0);
  });
});

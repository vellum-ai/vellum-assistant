/**
 * Tests for `WebsiteCarousel`.
 *
 * bun:test doesn't ship a `vi.useFakeTimers()` equivalent, so we drive the
 * carousel's `setTimeout` manually by monkey-patching the global. Each timeout
 * the component schedules is captured, then fired from `act()` to advance the
 * walk without real-time delays. This lets us assert that an advance only
 * happens once the `minDwellMs` timeout fires (the 0.5s floor) and that the
 * carousel walks toward the latest item and then holds — never wrapping back.
 *
 * The reduced-motion path is verified by stubbing `motion/react` so that
 * `useReducedMotion()` returns `true` and `motion.div` resolves to a plain
 * `<div>` that strips animation-only props — this lets us assert on the
 * static DOM that no `y` transform leaked through.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { type ReactNode, act } from "react";

import { cleanup, render } from "@testing-library/react";

import { WebsiteCarousel } from "@/domains/chat/components/web-search/website-carousel";

// ---------------------------------------------------------------------------
// setTimeout harness
// ---------------------------------------------------------------------------

interface TimeoutHandle {
  id: number;
  fn: () => void;
  ms: number;
  cleared: boolean;
}

let timeouts: TimeoutHandle[] = [];
let nextTimeoutId = 1;
let setTimeoutCallCount = 0;
let originalSetTimeout: typeof globalThis.setTimeout;
let originalClearTimeout: typeof globalThis.clearTimeout;

beforeEach(() => {
  timeouts = [];
  nextTimeoutId = 1;
  setTimeoutCallCount = 0;
  originalSetTimeout = globalThis.setTimeout;
  originalClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = ((
    fn: (...args: unknown[]) => void,
    ms?: number,
  ) => {
    setTimeoutCallCount += 1;
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
});

/**
 * Fire every currently-pending (non-cleared) timeout once. The component
 * schedules at most one timeout per render, so this advances the walk by a
 * single step. After firing, the timeout is marked cleared so it isn't
 * re-fired on the next call.
 */
function fireDwellTimer() {
  for (const handle of timeouts) {
    if (!handle.cleared) {
      handle.cleared = true;
      act(() => {
        handle.fn();
      });
    }
  }
}

/** Count of timeouts that are still pending (scheduled and not yet fired/cleared). */
function pendingTimeouts() {
  return timeouts.filter((h) => !h.cleared);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const ITEMS = [
  { faviconUrl: "https://a.test/favicon.ico", title: "Alpha", domain: "a.test" },
  { faviconUrl: "https://b.test/favicon.ico", title: "Bravo", domain: "b.test" },
  { faviconUrl: "https://c.test/favicon.ico", title: "Charlie", domain: "c.test" },
];

describe("WebsiteCarousel — walk to latest", () => {
  test("advances one step per dwell tick toward the last item, then holds", () => {
    const { getByText } = render(
      <WebsiteCarousel items={ITEMS} minDwellMs={1000} />,
    );
    // Initial frame shows the first item.
    expect(getByText("Alpha")).toBeTruthy();
    // After one dwell tick → second item visible.
    fireDwellTimer();
    expect(getByText("Bravo")).toBeTruthy();
    // After another tick → the last (latest) item is visible.
    // Note: `AnimatePresence mode="popLayout"` retains the previous element
    // during its exit animation, so we only assert that the new entry is in
    // the tree — the old one may still be there mid-fade.
    fireDwellTimer();
    expect(getByText("Charlie")).toBeTruthy();
    // Once caught up to the latest, the walk holds: no further timer is
    // scheduled, and it does NOT wrap back to the first item.
    expect(pendingTimeouts()).toHaveLength(0);
    expect(getByText("Charlie")).toBeTruthy();
  });

  test("does not advance before the dwell timeout fires (honours the floor)", () => {
    const { getByText } = render(
      <WebsiteCarousel items={ITEMS} minDwellMs={500} />,
    );
    // A timer is scheduled but not yet fired — still on the first item.
    expect(getByText("Alpha")).toBeTruthy();
    expect(pendingTimeouts()).toHaveLength(1);
    expect(pendingTimeouts()[0]!.ms).toBe(500);
  });

  test("resumes the walk when a newer item is appended", () => {
    const { getByText, rerender } = render(
      <WebsiteCarousel items={ITEMS} minDwellMs={500} />,
    );
    // Walk to the current latest item.
    fireDwellTimer(); // Bravo
    fireDwellTimer(); // Charlie
    expect(getByText("Charlie")).toBeTruthy();
    expect(pendingTimeouts()).toHaveLength(0);

    // Parent appends a newer searched site — the target grows and the walk
    // resumes toward it.
    const moreItems = [
      ...ITEMS,
      {
        faviconUrl: "https://d.test/favicon.ico",
        title: "Delta",
        domain: "d.test",
      },
    ];
    rerender(<WebsiteCarousel items={moreItems} minDwellMs={500} />);
    expect(pendingTimeouts()).toHaveLength(1);
    fireDwellTimer();
    expect(getByText("Delta")).toBeTruthy();
    expect(pendingTimeouts()).toHaveLength(0);
  });

  test("defaults minDwellMs to 500", () => {
    render(<WebsiteCarousel items={ITEMS} />);
    expect(pendingTimeouts()).toHaveLength(1);
    expect(pendingTimeouts()[0]!.ms).toBe(500);
  });
});

describe("WebsiteCarousel — degenerate cases", () => {
  test("with one item: renders it statically and never schedules a timer", () => {
    const { getByText } = render(
      <WebsiteCarousel items={[ITEMS[0]!]} minDwellMs={500} />,
    );
    expect(getByText("Alpha")).toBeTruthy();
    expect(setTimeoutCallCount).toBe(0);
  });

  test("with zero items: renders nothing and never schedules a timer", () => {
    const { container } = render(<WebsiteCarousel items={[]} />);
    expect(container.firstChild).toBeNull();
    expect(setTimeoutCallCount).toBe(0);
  });

  test("clears its pending timer on unmount", () => {
    const { unmount } = render(
      <WebsiteCarousel items={ITEMS} minDwellMs={500} />,
    );
    expect(pendingTimeouts()).toHaveLength(1);
    unmount();
    expect(pendingTimeouts()).toHaveLength(0);
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
        children?: ReactNode;
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
      // also stub `motion.span` (used by the header carousel) — otherwise
      // downstream suites that touch that card render
      // `undefined` and crash. Span is rendered as a passthrough since the
      // y-offset assertion only inspects `motion.div`.
      const motionSpan = ({
        children,
        ...rest
      }: {
        children?: ReactNode;
        [key: string]: unknown;
      }) => <span {...rest}>{children}</span>;
      return {
        motion: { div: motionDiv, span: motionSpan },
        AnimatePresence: ({ children }: { children?: ReactNode }) => (
          <>{children}</>
        ),
        useReducedMotion: () => true,
      };
    });

    const { WebsiteCarousel: PatchedCarousel } = await import(
      "./website-carousel"
    );
    render(<PatchedCarousel items={ITEMS} minDwellMs={500} />);

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

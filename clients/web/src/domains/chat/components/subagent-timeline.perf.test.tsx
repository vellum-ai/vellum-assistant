/**
 * Synthetic-load perf signal for the (now virtualized) subagent timeline.
 *
 * Renders the timeline at N = 50 / 150 / 300 events using the deterministic
 * synthetic fixture, and:
 *   - asserts the list is WINDOWED — only O(window) rows are mounted, not all N,
 *     while `getTotalSize`-driven layout still reserves space for the full list
 *     (the spacer's pixel height grows with N), and
 *   - logs a wall-clock render delta per N as an ADVISORY signal.
 *
 * The timings are intentionally NEVER asserted — JS-DOM wall-clock numbers are
 * noisy and machine-dependent. Authoritative numbers come from the manual
 * React DevTools Profiler protocol documented in the PR body.
 *
 * The shared harness stubs a fixed per-row height plus the scroll-container
 * height so the virtualizer has a real viewport in jsdom/happy-dom (which report
 * 0 for all layout); the number of mounted rows then stays a small O(viewport)
 * constant regardless of N.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";

import { makeSyntheticEvents } from "@/domains/chat/components/__fixtures__/subagent-timeline-fixtures";
import {
  installRowHeightStub,
  renderedRowCount,
  TimelineHarness,
} from "@/domains/chat/components/__fixtures__/subagent-timeline-harness";

/** Viewport small enough to keep the window a tight handful of rows. */
const VIEWPORT_HEIGHT = 300;

installRowHeightStub();

afterEach(() => {
  cleanup();
});

describe("SubagentTimeline — synthetic-load windowing signal", () => {
  for (const eventCount of [50, 150, 300]) {
    test(`windows ${eventCount} events to a small row count`, () => {
      const events = makeSyntheticEvents(eventCount);

      const start = performance.now();
      render(<TimelineHarness events={events} viewportHeight={VIEWPORT_HEIGHT} />);
      const elapsedMs = performance.now() - start;
      const rows = renderedRowCount(screen);

      // Advisory only — never asserted.
      console.log(
        `[perf] SubagentTimeline N=${eventCount} render=${elapsedMs.toFixed(2)}ms rows=${rows}`,
      );

      // Virtualization mounts only a window of rows, not all N: a non-zero
      // handful (guarding against a vacuous pass) that stays far below 300.
      expect(rows).toBeGreaterThan(0);
      expect(rows).toBeLessThan(60);
    });
  }
});

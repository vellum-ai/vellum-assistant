/**
 * Synthetic-load perf baseline for the subagent timeline.
 *
 * Renders the CURRENT timeline (memo + `content-visibility:auto` renders-all)
 * at N = 50 / 150 / 300 events using the deterministic synthetic fixture, and:
 *   - asserts every event produces a rendered row (structural correctness), and
 *   - logs a wall-clock render delta per N as an ADVISORY signal.
 *
 * The timings are intentionally NEVER asserted — JS-DOM wall-clock numbers are
 * noisy and machine-dependent. Authoritative numbers come from the manual
 * React DevTools Profiler protocol documented in the PR body. This file just
 * pins the structural baseline that virtualization (a later PR) must preserve.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";

import { makeSyntheticEvents } from "@/domains/chat/components/__fixtures__/subagent-timeline-fixtures";
import { SubagentTimeline } from "@/domains/chat/components/subagent-timeline";

/** Per-event card titles the timeline renders, one per (non-filtered) event. */
const ROW_TITLES = ["Response", "Tool Call", "Tool Result", "Error"];

/** Count rendered rows by summing every per-event title occurrence. */
function renderedRowCount(): number {
  return ROW_TITLES.reduce(
    (total, title) => total + screen.queryAllByText(title).length,
    0,
  );
}

afterEach(() => {
  cleanup();
});

describe("SubagentTimeline — synthetic-load perf baseline", () => {
  for (const eventCount of [50, 150, 300]) {
    test(`renders all ${eventCount} events`, () => {
      const events = makeSyntheticEvents(eventCount);

      const start = performance.now();
      render(<SubagentTimeline events={events} />);
      const elapsedMs = performance.now() - start;

      // Advisory only — never asserted.
      console.log(
        `[perf] SubagentTimeline N=${eventCount} render=${elapsedMs.toFixed(2)}ms`,
      );

      // The fixture emits only non-empty events, so none are filtered out:
      // every event must produce exactly one row.
      expect(renderedRowCount()).toBe(eventCount);
    });
  }
});

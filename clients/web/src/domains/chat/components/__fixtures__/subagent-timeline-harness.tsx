/**
 * Shared test harness for the virtualized subagent timeline.
 *
 * `@tanstack/react-virtual` measures each row via `offsetHeight` and derives the
 * viewport from the scroll element's `offsetHeight`; jsdom/happy-dom report 0 for
 * all layout, so without stubs every row collapses to 0px and the virtualizer
 * over-fills the viewport. This module centralizes the two workarounds both
 * timeline test files need:
 *   - `installRowHeightStub()` — a fixed per-row `offsetHeight` on the prototype,
 *     wired into `beforeAll`/`afterAll`.
 *   - `TimelineHarness` — renders the timeline against a scroll container whose
 *     height is stubbed. The scroll element lives in this parent while the
 *     virtualizer's mount effect runs in the child (which fires before the
 *     parent's ref attaches), so the node is held in state: attaching it
 *     re-renders, letting the virtualizer re-read a now-populated `scrollRef`.
 */

import { useMemo, useState } from "react";

import { afterAll, beforeAll } from "bun:test";
import type { screen } from "@testing-library/react";

import { SubagentTimeline } from "@/domains/chat/components/subagent-timeline";
import type { SubagentTimelineEvent } from "@/domains/chat/subagent-store";

/** Default per-row height (px); mirrors the hook's `DEFAULT_ROW_ESTIMATE`. */
export const ROW_HEIGHT = 96;

/** Per-event card titles, one per (non-filtered) event. */
export const ROW_TITLES = ["Response", "Tool Call", "Tool Result", "Error"];

/** Count rendered timeline rows by summing every per-event title occurrence. */
export function renderedRowCount(screenApi: typeof screen): number {
  return ROW_TITLES.reduce(
    (total, title) => total + screenApi.queryAllByText(title).length,
    0,
  );
}

/**
 * Stub `HTMLElement.prototype.offsetHeight` to a fixed row height for the
 * duration of the suite, restoring the original descriptor afterwards. Call at
 * the top level of a `describe` (or file).
 */
export function installRowHeightStub(rowHeight = ROW_HEIGHT): void {
  let original: PropertyDescriptor | undefined;
  beforeAll(() => {
    original = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "offsetHeight",
    );
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get() {
        return rowHeight;
      },
    });
  });
  afterAll(() => {
    if (original) {
      Object.defineProperty(HTMLElement.prototype, "offsetHeight", original);
    } else {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)
        .offsetHeight;
    }
  });
}

/** Render the timeline against a scroll container with a stubbed viewport height. */
export function TimelineHarness({
  events,
  viewportHeight = 800,
}: {
  events: SubagentTimelineEvent[];
  viewportHeight?: number;
}) {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const setRef = (el: HTMLDivElement | null) => {
    if (el) {
      Object.defineProperty(el, "offsetHeight", {
        configurable: true,
        value: viewportHeight,
      });
    }
    setNode(el);
  };
  // Stable ref-shaped object whose `.current` tracks the attached node.
  const scrollRef = useMemo(() => ({ current: node }), [node]);
  return (
    <div ref={setRef} style={{ height: viewportHeight, overflowY: "auto" }}>
      <SubagentTimeline scrollRef={scrollRef} events={events} />
    </div>
  );
}

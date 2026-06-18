/**
 * Tool-call timeline rows must let long, unbreakable content (file paths,
 * URLs, long identifiers) wrap instead of overflowing the card and being
 * clipped at the panel edge.
 *
 * The tool-call row lays `toolName` + `content` out as flex children, so each
 * needs `min-w-0` (to shrink below its intrinsic min-content width — flex
 * children default to `min-width: auto`) plus `break-words` (to actually break
 * the long token once shrunk). Regression guard for the cut-off bug.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { makeSyntheticEvents } from "@/domains/chat/components/__fixtures__/subagent-timeline-fixtures";
import {
  installRowHeightStub,
  renderedRowCount,
  TimelineHarness,
} from "@/domains/chat/components/__fixtures__/subagent-timeline-harness";
import type { SubagentTimelineEvent } from "@/domains/chat/subagent-store";

// jsdom/happy-dom report 0 for all layout; give rows a fixed measured height so
// the virtualizer forms a real window (see the harness module for details).
installRowHeightStub();

function renderTimeline(
  events: SubagentTimelineEvent[],
  viewportHeight = 800,
) {
  return render(
    <TimelineHarness events={events} viewportHeight={viewportHeight} />,
  );
}

const LONG_PATH =
  "/workspaces/worktrees/p3-fixup-fork/clients/web/src/domains/channel/handler-inbound-admission.test.ts";

function toolCallEvent(
  overrides: Partial<SubagentTimelineEvent> = {},
): SubagentTimelineEvent {
  return {
    id: "evt-1",
    type: "tool_call",
    content: LONG_PATH,
    toolName: "Read",
    timestamp: 0,
    ...overrides,
  };
}

/** Multi-line content that exceeds the collapsed line limit, so the row
 *  renders a collapsible "Show more" affordance. */
function longLines(label: string): string {
  return Array.from({ length: 8 }, (_, i) => `${label} line ${i}`).join("\n");
}

function toolResultEvent(
  overrides: Partial<SubagentTimelineEvent> = {},
): SubagentTimelineEvent {
  return {
    id: "evt-result",
    type: "tool_result",
    content: longLines("result"),
    timestamp: 0,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe("SubagentTimeline — tool_call content wrapping", () => {
  test("long content carries wrapping classes so it can't overflow the card", () => {
    renderTimeline([toolCallEvent()]);

    const content = screen.getByText(LONG_PATH);
    expect(content.className).toContain("min-w-0");
    expect(content.className).toContain("break-words");
  });

  test("tool name carries wrapping classes too", () => {
    const longName = "some_extremely_long_tool_name_identifier_that_could_overflow";
    renderTimeline([toolCallEvent({ toolName: longName })]);

    const name = screen.getByText(longName);
    expect(name.className).toContain("min-w-0");
    expect(name.className).toContain("break-words");
  });
});

describe("SubagentTimeline — expand state keyed by event.id", () => {
  test("expanding one row, then toggling another, leaves the first expanded", () => {
    const first = toolResultEvent({ id: "evt-a", content: longLines("a") });
    const second = toolResultEvent({ id: "evt-b", content: longLines("b") });
    renderTimeline([first, second]);

    // Both rows start collapsed.
    const toggles = screen.getAllByText("Show more");
    expect(toggles).toHaveLength(2);

    // Expand the first row.
    fireEvent.click(toggles[0]!);

    // First is now expanded ("Show less"), second still collapsed.
    expect(screen.getByText("Show less")).toBeDefined();
    expect(screen.getByText("Show more")).toBeDefined();
    // The first row's last line is only visible once expanded.
    expect(screen.getByText(/a line 7/)).toBeDefined();

    // Toggle the second row (it's the remaining "Show more").
    fireEvent.click(screen.getByText("Show more"));

    // The first row's expansion must be unaffected — both now expanded.
    expect(screen.getAllByText("Show less")).toHaveLength(2);
    expect(screen.getByText(/a line 7/)).toBeDefined();
    expect(screen.getByText(/b line 7/)).toBeDefined();
  });
});

describe("SubagentTimeline — virtualization windows the list", () => {
  test("mounts only a window of rows for a large list, not all of them", () => {
    // A 300px viewport over ~96px rows windows to a handful of rows + overscan,
    // so far fewer than all 300 events are in the DOM.
    renderTimeline(makeSyntheticEvents(300), 300);

    const rendered = renderedRowCount(screen);
    expect(rendered).toBeGreaterThan(0); // guard: not a vacuous pass
    expect(rendered).toBeLessThan(60);
  });
});

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

import { SubagentTimeline } from "@/domains/chat/components/subagent-timeline";
import type { SubagentTimelineEvent } from "@/domains/chat/subagent-store";

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

/** Content with enough lines to exceed the collapsed limit (4 lines). */
function longText(label: string): string {
  return [`${label} line 1`, "line 2", "line 3", "line 4", "line 5"].join("\n");
}

function toolResultEvent(
  overrides: Partial<SubagentTimelineEvent> = {},
): SubagentTimelineEvent {
  return {
    id: "res-1",
    type: "tool_result",
    content: longText("result"),
    timestamp: 0,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe("SubagentTimeline — tool_call content wrapping", () => {
  test("long content carries wrapping classes so it can't overflow the card", () => {
    render(<SubagentTimeline events={[toolCallEvent()]} />);

    const content = screen.getByText(LONG_PATH);
    expect(content.className).toContain("min-w-0");
    expect(content.className).toContain("break-words");
  });

  test("tool name carries wrapping classes too", () => {
    const longName = "some_extremely_long_tool_name_identifier_that_could_overflow";
    render(<SubagentTimeline events={[toolCallEvent({ toolName: longName })]} />);

    const name = screen.getByText(longName);
    expect(name.className).toContain("min-w-0");
    expect(name.className).toContain("break-words");
  });
});

describe("SubagentTimeline — expansion state keyed by event.id", () => {
  test("expanding one row stays expanded while a second row is toggled", () => {
    render(
      <SubagentTimeline
        events={[
          toolResultEvent({ id: "res-a", content: longText("a") }),
          toolResultEvent({ id: "res-b", content: longText("b") }),
        ]}
      />,
    );

    // Both rows start collapsed: two "Show more" toggles, no "Show less".
    expect(screen.getAllByText("Show more")).toHaveLength(2);
    expect(screen.queryByText("Show less")).toBeNull();

    // Expand the first row.
    fireEvent.click(screen.getAllByRole("button")[0]);
    expect(screen.getAllByText("Show less")).toHaveLength(1);
    expect(screen.getAllByText("Show more")).toHaveLength(1);
    // First row's full content is visible (getByText throws if absent).
    screen.getByText(/a line 1[\s\S]*line 5/);

    // Toggle the second row (now the only remaining "Show more").
    fireEvent.click(screen.getByText("Show more"));

    // Both rows are now expanded — the first stayed expanded, proving
    // expansion is keyed by event.id and held above the row.
    expect(screen.getAllByText("Show less")).toHaveLength(2);
    expect(screen.queryByText("Show more")).toBeNull();
    screen.getByText(/a line 1[\s\S]*line 5/);
    screen.getByText(/b line 1[\s\S]*line 5/);
  });
});

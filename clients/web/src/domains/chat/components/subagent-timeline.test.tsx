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
import { cleanup, render, screen } from "@testing-library/react";

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

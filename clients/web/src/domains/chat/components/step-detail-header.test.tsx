/**
 * `StepDetailGlyph` reads whether its step is in flight from the live call, as
 * the step's body does, so a step opened while running turns to its icon once
 * the call settles.
 */

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";

import { cleanup, render, screen } from "@testing-library/react";

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";

let liveCall: ChatMessageToolCall | null = null;

const realLiveToolCall =
  await import("@/domains/chat/hooks/use-live-tool-call");
mock.module("@/domains/chat/hooks/use-live-tool-call", () => ({
  ...realLiveToolCall,
  useLiveToolCall: () => liveCall,
}));

import { StepDetailGlyph } from "@/domains/chat/components/step-detail-header";
import type { ToolDetailPayload } from "@/stores/viewer-store";

afterEach(() => {
  cleanup();
  liveCall = null;
});
afterAll(() => {
  mock.restore();
});

/** The payload as the panel captured it when the step was opened, mid-run. */
const OPENED_WHILE_RUNNING: ToolDetailPayload = {
  toolCallId: "tool-1",
  toolName: "bash",
  title: "Run Command",
  activity: "Listing files",
  input: { command: "ls" },
  status: "running",
};

const SOURCE = realLiveToolCall.TRANSCRIPT_TOOL_CALL_SOURCE;

describe("StepDetailGlyph", () => {
  test("shows the step's icon once the live call has settled", () => {
    liveCall = {
      id: "tool-1",
      name: "bash",
      input: { command: "ls" },
      result: "README.md",
      startedAt: 1,
      completedAt: 2,
    };
    render(<StepDetailGlyph detail={OPENED_WHILE_RUNNING} source={SOURCE} />);

    expect(screen.queryByTestId("nested-detail-running")).toBeNull();
  });

  test("shows the running indicator while the live call is in flight", () => {
    liveCall = {
      id: "tool-1",
      name: "bash",
      input: { command: "ls" },
      startedAt: 1,
    };
    render(<StepDetailGlyph detail={OPENED_WHILE_RUNNING} source={SOURCE} />);

    expect(screen.getByTestId("nested-detail-running")).toBeDefined();
  });

  test("falls back to the payload's status when no live call resolves", () => {
    render(<StepDetailGlyph detail={OPENED_WHILE_RUNNING} source={SOURCE} />);

    expect(screen.getByTestId("nested-detail-running")).toBeDefined();
  });
});

import { describe, expect, test } from "bun:test";

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import { workflowRunIdForCall } from "@/domains/chat/transcript/transcript-message-body-shared";

function call(partial: Partial<ChatMessageToolCall>): ChatMessageToolCall {
  return { id: "tc", name: "skill_execute", ...partial } as ChatMessageToolCall;
}

const NO_ANCHOR = new Map<string, string>();

describe("workflowRunIdForCall", () => {
  test("resolves via the byToolUseId anchor", () => {
    const tc = call({ id: "tc-a", input: { tool: "run_workflow" } });
    expect(workflowRunIdForCall(tc, new Map([["tc-a", "run-123"]]))).toBe(
      "run-123",
    );
  });

  test("falls back to the runId encoded in the tool result", () => {
    const tc = call({
      id: "tc-b",
      input: { tool: "run_workflow" },
      result: JSON.stringify({ runId: "run-456", status: "running" }),
    });
    expect(workflowRunIdForCall(tc, NO_ANCHOR)).toBe("run-456");
  });

  test("returns null for a non-run_workflow tool call", () => {
    const tc = call({ id: "tc-c", input: { tool: "something_else" } });
    expect(workflowRunIdForCall(tc, NO_ANCHOR)).toBeNull();
  });

  test("returns null when run_workflow failed before returning a runId", () => {
    // A failed run_workflow returns a plain error string, not JSON with a runId,
    // and never emitted a workflow_started event (no anchor). The transcript must
    // therefore keep rendering its tool result so the error stays visible.
    const tc = call({
      id: "tc-d",
      input: { tool: "run_workflow" },
      result: "Failed to start workflow: agent cap exceeded",
    });
    expect(workflowRunIdForCall(tc, NO_ANCHOR)).toBeNull();
  });
});

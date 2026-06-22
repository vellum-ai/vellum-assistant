import { describe, expect, test } from "bun:test";

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import {
  computeCardBackedWorkflowRunIds,
  workflowRunIdForCall,
  type WorkflowCardBackingState,
} from "@/domains/chat/transcript/transcript-message-body-shared";

function call(partial: Partial<ChatMessageToolCall>): ChatMessageToolCall {
  return { id: "tc", name: "skill_execute", ...partial } as ChatMessageToolCall;
}

const NO_ANCHOR = new Map<string, string>();

/** A run_workflow call whose runId is recoverable from its persisted result. */
function wfCall(id: string, runId: string): ChatMessageToolCall {
  return call({
    id,
    input: { tool: "run_workflow" },
    result: JSON.stringify({ runId, status: "running" }),
  });
}

function backingState(
  overrides: Partial<WorkflowCardBackingState> = {},
): WorkflowCardBackingState {
  return {
    byId: {},
    byToolUseId: new Map<string, string>(),
    notFoundRunIds: new Set<string>(),
    hydrationFailedRunIds: new Set<string>(),
    ...overrides,
  };
}

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

describe("computeCardBackedWorkflowRunIds", () => {
  test("card-backs a run whose entry already exists", () => {
    const backed = computeCardBackedWorkflowRunIds(
      [wfCall("tc-a", "run-1")],
      backingState({ byId: { "run-1": {} } }),
    );
    expect(backed.has("run-1")).toBe(true);
  });

  test("card-backs a run whose hydration is still pending (no entry, no failure)", () => {
    // Suppress optimistically so the happy path doesn't flash the raw chip
    // before the on-demand hydration lands.
    const backed = computeCardBackedWorkflowRunIds(
      [wfCall("tc-a", "run-1")],
      backingState(),
    );
    expect(backed.has("run-1")).toBe(true);
  });

  test("does NOT card-back a confirmed 404 run", () => {
    const backed = computeCardBackedWorkflowRunIds(
      [wfCall("tc-a", "run-1")],
      backingState({ notFoundRunIds: new Set(["run-1"]) }),
    );
    expect(backed.has("run-1")).toBe(false);
  });

  test("does NOT card-back a transiently-failed run (keeps the raw result visible)", () => {
    // The regression: a transient hydration failure leaves no entry, so the
    // chip must stay visible instead of vanishing behind a blank card.
    const backed = computeCardBackedWorkflowRunIds(
      [wfCall("tc-a", "run-1")],
      backingState({ hydrationFailedRunIds: new Set(["run-1"]) }),
    );
    expect(backed.has("run-1")).toBe(false);
  });

  test("an existing entry overrides a stale transient-failure mark", () => {
    // Reload-mid-run: hydration failed transiently, then a live event populated
    // the entry. `byId` is checked first, so the card-backs again.
    const backed = computeCardBackedWorkflowRunIds(
      [wfCall("tc-a", "run-1")],
      backingState({
        byId: { "run-1": {} },
        hydrationFailedRunIds: new Set(["run-1"]),
      }),
    );
    expect(backed.has("run-1")).toBe(true);
  });

  test("ignores a run_workflow call that resolves no runId", () => {
    const tc = call({
      id: "tc-a",
      input: { tool: "run_workflow" },
      result: "Failed to start workflow: agent cap exceeded",
    });
    expect(computeCardBackedWorkflowRunIds([tc], backingState()).size).toBe(0);
  });
});

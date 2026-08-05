import { describe, expect, test } from "bun:test";

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import {
  computeCardBackedWorkflowRunIds,
  resolveChangedDocuments,
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

/** A document tool call whose surface id is recoverable from its result. */
function docCall(
  id: string,
  tool: string,
  surfaceId: string,
  overrides: Partial<ChatMessageToolCall> = {},
): ChatMessageToolCall {
  return call({
    id,
    name: tool,
    input: { surface_id: surfaceId },
    result: JSON.stringify({ success: true, surface_id: surfaceId }),
    ...overrides,
  });
}

describe("resolveChangedDocuments", () => {
  test("resolves the surface id a single update wrote to", () => {
    const tc = docCall("tc-a", "document_update", "doc-1");
    expect(resolveChangedDocuments([tc], new Set())).toEqual(["doc-1"]);
  });

  test("resolves a call delivered inside a skill_execute envelope", () => {
    const tc = call({
      id: "tc-a",
      name: "skill_execute",
      input: { tool: "document_update", surface_id: "doc-1" },
      result: JSON.stringify({ success: true, surface_id: "doc-1" }),
    });
    expect(resolveChangedDocuments([tc], new Set())).toEqual(["doc-1"]);
  });

  test("collapses a create then an update of the same document to one entry", () => {
    const calls = [
      docCall("tc-a", "document_create", "doc-1"),
      docCall("tc-b", "document_update", "doc-1"),
    ];
    expect(resolveChangedDocuments(calls, new Set())).toEqual(["doc-1"]);
  });

  test("returns two different documents in first-changed order", () => {
    const calls = [
      docCall("tc-a", "document_update", "doc-2"),
      docCall("tc-b", "document_replace_text", "doc-1"),
    ];
    expect(resolveChangedDocuments(calls, new Set())).toEqual([
      "doc-2",
      "doc-1",
    ]);
  });

  test("a shared claimed Set stops a second group anchoring the same document", () => {
    const claimed = new Set<string>();
    const first = docCall("tc-a", "document_update", "doc-1");
    const second = docCall("tc-b", "document_update", "doc-1");
    expect(resolveChangedDocuments([first], claimed)).toEqual(["doc-1"]);
    expect(resolveChangedDocuments([second], claimed)).toEqual([]);
  });

  test("ignores a malformed, non-JSON result without throwing", () => {
    const tc = docCall("tc-a", "document_update", "doc-1", {
      result: "Failed to update document: no document is open",
    });
    expect(resolveChangedDocuments([tc], new Set())).toEqual([]);
  });

  test("ignores a result whose JSON carries no surface_id", () => {
    const tc = docCall("tc-a", "document_update", "doc-1", {
      result: JSON.stringify({ success: true }),
    });
    expect(resolveChangedDocuments([tc], new Set())).toEqual([]);
  });

  test("ignores a call whose result has not landed yet", () => {
    const tc = docCall("tc-a", "document_update", "doc-1", {
      result: undefined,
    });
    expect(resolveChangedDocuments([tc], new Set())).toEqual([]);
  });

  test("ignores non-document tool calls", () => {
    const calls = [
      call({ id: "tc-a", name: "document_read", result: "{}" }),
      call({
        id: "tc-b",
        name: "file_write",
        result: JSON.stringify({ surface_id: "doc-1" }),
      }),
    ];
    expect(resolveChangedDocuments(calls, new Set())).toEqual([]);
  });

  test("ignores an errored call even when its result carries a surface id", () => {
    // A failed document_replace_text still echoes the surface id it targeted,
    // but nothing changed, so there is no document to reopen.
    const tc = docCall("tc-a", "document_replace_text", "doc-1", {
      isError: true,
      result: JSON.stringify({
        success: false,
        surface_id: "doc-1",
        error: "text not found",
      }),
    });
    expect(resolveChangedDocuments([tc], new Set())).toEqual([]);
  });
});

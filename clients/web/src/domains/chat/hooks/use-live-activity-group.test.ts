/**
 * Tests for `filterCardBackedProcessCalls` — the pure suppression the live
 * activity-group projection applies so an open activity-steps panel hides the
 * same card-backed process calls (`run_workflow`, `acp_spawn`, backgrounded
 * `bash`) the transcript hides in favor of their inline process cards.
 */

import { describe, expect, test } from "bun:test";

import {
  filterCardBackedProcessCalls,
  type ProcessCardBacking,
} from "@/domains/chat/hooks/use-live-activity-group";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import type { ToolCallCardItem } from "@/domains/chat/utils/tool-call-card-utils";

function emptyBacking(): ProcessCardBacking {
  return {
    workflow: {
      byId: {},
      byToolUseId: new Map(),
      notFoundRunIds: new Set(),
      hydrationFailedRunIds: new Set(),
    },
    acpById: {},
    acpByToolUseId: new Map(),
    backgroundTaskById: {},
  };
}

const BASH: ChatMessageToolCall = {
  id: "tc-bash",
  name: "bash",
  input: { command: "ls" },
};

const WORKFLOW: ChatMessageToolCall = {
  id: "tc-wf",
  name: "run_workflow",
  input: { name: "find-flaky-tests" },
};

const ACP: ChatMessageToolCall = {
  id: "tc-acp",
  name: "acp_spawn",
  input: { task: "review" },
};

const BG_BASH: ChatMessageToolCall = {
  id: "tc-bg",
  name: "bash",
  input: { command: "sleep 600", background: true },
  result: JSON.stringify({ backgrounded: true, id: "bg-1" }),
};

function itemsFor(toolCalls: ChatMessageToolCall[]): ToolCallCardItem[] {
  return [
    { kind: "thinking", text: "planning" },
    ...toolCalls.map(
      (tc): ToolCallCardItem => ({ kind: "toolCall", toolCall: tc }),
    ),
  ];
}

describe("filterCardBackedProcessCalls", () => {
  test("returns the same references when nothing is card-backed", () => {
    const toolCalls = [BASH, WORKFLOW, ACP, BG_BASH];
    const items = itemsFor(toolCalls);
    const result = filterCardBackedProcessCalls(
      items,
      toolCalls,
      emptyBacking(),
    );
    // No backing store entries and no resolvable process ids → every call
    // keeps rendering as a step (a failed / not-yet-backed process call must
    // not vanish), and the inputs pass through by reference.
    expect(result.items).toBe(items);
    expect(result.toolCalls).toBe(toolCalls);
  });

  test("keeps a workflow call whose hydration definitively failed", () => {
    const backing = emptyBacking();
    backing.workflow.byToolUseId = new Map([["tc-wf", "run-1"]]);
    backing.workflow.notFoundRunIds = new Set(["run-1"]);
    const toolCalls = [WORKFLOW, BASH];
    const result = filterCardBackedProcessCalls(
      itemsFor(toolCalls),
      toolCalls,
      backing,
    );
    expect(result.toolCalls.map((tc) => tc.id)).toEqual(["tc-wf", "tc-bash"]);
  });

  test("drops a card-backed run_workflow call and its card item", () => {
    const backing = emptyBacking();
    backing.workflow.byToolUseId = new Map([["tc-wf", "run-1"]]);
    backing.workflow.byId = { "run-1": {} };
    const toolCalls = [WORKFLOW, BASH];
    const result = filterCardBackedProcessCalls(
      itemsFor(toolCalls),
      toolCalls,
      backing,
    );
    expect(result.toolCalls.map((tc) => tc.id)).toEqual(["tc-bash"]);
    // The thinking item stays; the workflow's toolCall item is gone.
    expect(result.items.map((it) => it.kind)).toEqual([
      "thinking",
      "toolCall",
    ]);
  });

  test("drops a card-backed acp_spawn call", () => {
    const backing = emptyBacking();
    backing.acpByToolUseId = new Map([["tc-acp", "acp-1"]]);
    backing.acpById = { "acp-1": {} };
    const toolCalls = [ACP, BASH];
    const result = filterCardBackedProcessCalls(
      itemsFor(toolCalls),
      toolCalls,
      backing,
    );
    expect(result.toolCalls.map((tc) => tc.id)).toEqual(["tc-bash"]);
  });

  test("drops a card-backed backgrounded bash call", () => {
    const backing = emptyBacking();
    backing.backgroundTaskById = { "bg-1": {} };
    const toolCalls = [BG_BASH, BASH];
    const result = filterCardBackedProcessCalls(
      itemsFor(toolCalls),
      toolCalls,
      backing,
    );
    expect(result.toolCalls.map((tc) => tc.id)).toEqual(["tc-bash"]);
  });
});

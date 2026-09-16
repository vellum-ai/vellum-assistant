/**
 * Tests for `filterCardBackedProcessCalls` — the pure suppression the live
 * activity-group projection applies so an open activity-steps panel hides the
 * same card-backed process calls (`run_workflow`, `acp_spawn`, backgrounded
 * `bash`) the transcript hides in favor of their inline process cards.
 */

import { describe, expect, test } from "bun:test";

import {
  filterCardBackedProcessCalls,
  isLastActivityGroup,
  isLatestTranscriptMessage,
  resolveActivityGroupIndex,
  type ProcessCardBacking,
} from "@/domains/chat/hooks/use-live-activity-group";
import type { ContentBlockGroup } from "@/domains/chat/transcript/message-content";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import type { DisplayMessage } from "@/domains/chat/types/types";
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
    ...toolCalls.map((tc): ToolCallCardItem => ({
      kind: "toolCall",
      toolCall: tc,
    })),
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
    expect(result.items.map((it) => it.kind)).toEqual(["thinking", "toolCall"]);
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

describe("isLastActivityGroup", () => {
  const activity = (): ContentBlockGroup => ({ type: "activity", items: [] });

  test("marks only a trailing activity group active", () => {
    expect(isLastActivityGroup([activity()], 0)).toBe(true);
    expect(
      isLastActivityGroup(
        [activity(), { type: "text", text: "visible response" }],
        0,
      ),
    ).toBe(false);
  });

  test("does not mark a trailing non-activity group active", () => {
    expect(
      isLastActivityGroup([{ type: "text", text: "visible response" }], 0),
    ).toBe(false);
  });
});

describe("isLatestTranscriptMessage", () => {
  const message = (
    id: string,
    mergedMessageIds?: string[],
  ): DisplayMessage => ({
    id,
    role: "assistant",
    mergedMessageIds,
  });

  test("matches a cloned latest row by stable identity", () => {
    const selected = message("assistant-latest");
    const clonedLatest = { ...selected };

    expect(isLatestTranscriptMessage(selected, [clonedLatest])).toBe(true);
  });

  test("does not mistake a distinct older row for the latest", () => {
    expect(
      isLatestTranscriptMessage(message("assistant-older"), [
        message("assistant-older"),
        message("assistant-latest"),
      ]),
    ).toBe(false);
  });

  test("matches a latest merged row through its donor identity", () => {
    expect(
      isLatestTranscriptMessage(message("assistant-donor"), [
        message("assistant-anchor", ["assistant-donor"]),
      ]),
    ).toBe(true);
  });
});

describe("resolveActivityGroupIndex", () => {
  const activity = (
    ...toolCalls: ChatMessageToolCall[]
  ): ContentBlockGroup => ({
    type: "activity",
    items: toolCalls.map((toolCall) => ({ type: "tool_use", toolCall })),
  });

  test("keeps the indexed block when it still owns the anchor", () => {
    expect(resolveActivityGroupIndex([activity(BASH)], 0, BASH.id)).toBe(0);
  });

  test("relocates a donor block after older prose and activity are prepended", () => {
    const groups: ContentBlockGroup[] = [
      { type: "text", text: "Earlier response" },
      activity(WORKFLOW),
      { type: "text", text: "Boundary" },
      activity(BASH),
    ];
    expect(resolveActivityGroupIndex(groups, 0, BASH.id)).toBe(3);
  });

  test("keeps locating an existing call when older history extends its group", () => {
    expect(
      resolveActivityGroupIndex([activity(WORKFLOW, BASH)], 0, BASH.id),
    ).toBe(0);
  });

  test("returns null instead of switching to another block when the anchor is gone", () => {
    expect(resolveActivityGroupIndex([activity(WORKFLOW)], 0, BASH.id)).toBe(
      null,
    );
  });

  test("retains exact-index behavior for identity-less groups", () => {
    const groups: ContentBlockGroup[] = [
      { type: "text", text: "Boundary" },
      activity(BASH),
    ];
    expect(resolveActivityGroupIndex(groups, 1)).toBe(1);
    expect(resolveActivityGroupIndex(groups, 0)).toBeNull();
  });
});

/**
 * Tests for `AcpRunInlineProgressCard` and its supporting projection/anchor
 * helpers.
 *
 *  - Card renders running / complete / cancelled / error states from a seeded
 *    ACP run store, plus the spawn-race `null` fallback and the header-click
 *    callback.
 *  - `isAcpSpawnCall` detection — direct `acp_spawn` and the `skill_execute`
 *    wrapper.
 *  - `resolveAcpRunIds` / `acpRunIdForCall` resolve via `byToolUseId` and the
 *    result-parse fallback.
 *  - Raw-chip suppression: a card-backed call resolves to a backing id; an
 *    absent or failed run resolves to none, so its chip stays.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { AcpRunInlineProgressCard } from "@/domains/chat/components/acp-run-inline-card/acp-run-inline-progress-card";
import {
  useAcpRunStore,
  type AcpRunRawEvent,
} from "@/domains/chat/acp-run-store";
import { isAcpSpawnCall } from "@/domains/chat/transcript/message-content";
import {
  acpRunIdForCall,
  resolveAcpRunIds,
} from "@/domains/chat/transcript/transcript-message-body-shared";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";

const NOW = 1700000000000;
const STATUS_TESTID = "acp-run-inline-card-status-indicator";

beforeEach(() => {
  useAcpRunStore.getState().reset();
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Store seeding helpers
// ---------------------------------------------------------------------------

function spawn(acpSessionId: string, parentToolUseId?: string) {
  useAcpRunStore.getState().spawnRun({
    acpSessionId,
    agent: "claude",
    parentConversationId: "conv-1",
    parentToolUseId,
    startedAt: NOW,
  });
}

function toolEvent(
  acpSessionId: string,
  overrides: Partial<AcpRunRawEvent>,
): void {
  useAcpRunStore.getState().receiveEvent({
    acpSessionId,
    event: { seq: 1, updateType: "tool_call", ...overrides },
  });
}

function terminal(
  acpSessionId: string,
  status: "completed" | "failed",
  stopReason?: string,
  error?: string,
): void {
  useAcpRunStore.getState().setTerminal({
    acpSessionId,
    status,
    stopReason,
    error,
    completedAt: NOW + 1000,
  });
}

function toolCall(overrides: Partial<ChatMessageToolCall>): ChatMessageToolCall {
  return {
    id: "tc-1",
    name: "acp_spawn",
    input: {},
    ...overrides,
  } as ChatMessageToolCall;
}

// ---------------------------------------------------------------------------
// Card render
// ---------------------------------------------------------------------------

describe("AcpRunInlineProgressCard — spawn race", () => {
  test("renders null when no entry exists in the store yet", () => {
    const { container } = render(
      <AcpRunInlineProgressCard acpSessionId="missing" />,
    );
    expect(container.firstChild).toBeNull();
  });
});

describe("AcpRunInlineProgressCard — states", () => {
  test("running run shows the three-dot loading indicator", () => {
    act(() => {
      spawn("acp-run");
      toolEvent("acp-run", { toolCallId: "t1", toolTitle: "Read file" });
    });

    const { getByTestId } = render(
      <AcpRunInlineProgressCard acpSessionId="acp-run" />,
    );

    const indicator = getByTestId(STATUS_TESTID);
    // The loading indicator is the ThreeDotIndicator span (no `data-state`).
    expect(indicator.getAttribute("data-state")).toBeNull();
  });

  test("completed run renders the complete status icon", () => {
    act(() => {
      spawn("acp-done");
      toolEvent("acp-done", { toolCallId: "t1", toolTitle: "Read file" });
      terminal("acp-done", "completed");
    });

    const { getByTestId } = render(
      <AcpRunInlineProgressCard acpSessionId="acp-done" />,
    );
    expect(getByTestId(STATUS_TESTID).getAttribute("data-state")).toBe(
      "complete",
    );
  });

  test("cancelled run (completed + stopReason) renders the warning icon", () => {
    act(() => {
      spawn("acp-cancel");
      terminal("acp-cancel", "completed", "cancelled");
    });

    const { getByTestId } = render(
      <AcpRunInlineProgressCard acpSessionId="acp-cancel" />,
    );
    expect(getByTestId(STATUS_TESTID).getAttribute("data-state")).toBe(
      "warning",
    );
  });

  test("failed run renders the error icon", () => {
    act(() => {
      spawn("acp-fail");
      terminal("acp-fail", "failed", undefined, "boom");
    });

    const { getByTestId } = render(
      <AcpRunInlineProgressCard acpSessionId="acp-fail" />,
    );
    expect(getByTestId(STATUS_TESTID).getAttribute("data-state")).toBe("error");
  });
});

describe("AcpRunInlineProgressCard — interaction", () => {
  test("clicking the header row invokes onAcpRunClick", () => {
    act(() => spawn("acp-open"));
    const seen: string[] = [];
    const { getByRole } = render(
      <AcpRunInlineProgressCard
        acpSessionId="acp-open"
        onAcpRunClick={(id) => seen.push(id)}
      />,
    );
    fireEvent.click(getByRole("button", { name: /open run/i }));
    expect(seen).toEqual(["acp-open"]);
  });

  test("stop button is absent while running when no onStopAcpRun handler is provided", () => {
    act(() => spawn("acp-no-stop"));
    const { queryByTestId } = render(
      <AcpRunInlineProgressCard acpSessionId="acp-no-stop" />,
    );
    expect(queryByTestId("acp-run-inline-card-stop")).toBeNull();
  });

  test("stop button renders and invokes the handler while in-flight, then hides on terminal", () => {
    act(() => spawn("acp-stop"));
    const seen: string[] = [];
    const { getByTestId, queryByTestId } = render(
      <AcpRunInlineProgressCard
        acpSessionId="acp-stop"
        onStopAcpRun={(id) => seen.push(id)}
      />,
    );
    fireEvent.click(getByTestId("acp-run-inline-card-stop"));
    expect(seen).toEqual(["acp-stop"]);

    act(() => terminal("acp-stop", "completed"));
    expect(queryByTestId("acp-run-inline-card-stop")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isAcpSpawnCall
// ---------------------------------------------------------------------------

describe("isAcpSpawnCall", () => {
  test("matches a direct acp_spawn call", () => {
    expect(isAcpSpawnCall(toolCall({ name: "acp_spawn" }))).toBe(true);
  });

  test("matches a skill_execute wrapper with input.tool === acp_spawn", () => {
    expect(
      isAcpSpawnCall(
        toolCall({ name: "skill_execute", input: { tool: "acp_spawn" } }),
      ),
    ).toBe(true);
  });

  test("rejects a skill_execute wrapping a different tool", () => {
    expect(
      isAcpSpawnCall(
        toolCall({ name: "skill_execute", input: { tool: "run_workflow" } }),
      ),
    ).toBe(false);
  });

  test("rejects an unrelated tool", () => {
    expect(isAcpSpawnCall(toolCall({ name: "bash", input: {} }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Anchor resolution
// ---------------------------------------------------------------------------

describe("acpRunIdForCall / resolveAcpRunIds", () => {
  test("resolves via byToolUseId anchor", () => {
    const byToolUseId = new Map([["tc-1", "acp-1"]]);
    const tc = toolCall({ id: "tc-1", name: "acp_spawn" });
    expect(acpRunIdForCall(tc, byToolUseId)).toBe("acp-1");
    expect(resolveAcpRunIds([tc], byToolUseId, new Set())).toEqual(["acp-1"]);
  });

  test("falls back to parsing acpSessionId from the result JSON", () => {
    const tc = toolCall({
      id: "tc-1",
      name: "acp_spawn",
      result: JSON.stringify({ acpSessionId: "acp-from-result" }),
    });
    expect(acpRunIdForCall(tc, new Map())).toBe("acp-from-result");
    expect(resolveAcpRunIds([tc], new Map(), new Set())).toEqual([
      "acp-from-result",
    ]);
  });

  test("byToolUseId wins over the result parse", () => {
    const byToolUseId = new Map([["tc-1", "acp-anchor"]]);
    const tc = toolCall({
      id: "tc-1",
      name: "acp_spawn",
      result: JSON.stringify({ acpSessionId: "acp-result" }),
    });
    expect(acpRunIdForCall(tc, byToolUseId)).toBe("acp-anchor");
  });

  test("returns null/[] for a failed call with no id", () => {
    const tc = toolCall({ id: "tc-1", name: "acp_spawn" });
    expect(acpRunIdForCall(tc, new Map())).toBeNull();
    expect(resolveAcpRunIds([tc], new Map(), new Set())).toEqual([]);
  });

  test("claimed set prevents two calls anchoring the same id", () => {
    const byToolUseId = new Map([
      ["tc-1", "acp-shared"],
      ["tc-2", "acp-shared"],
    ]);
    const calls = [
      toolCall({ id: "tc-1", name: "acp_spawn" }),
      toolCall({ id: "tc-2", name: "acp_spawn" }),
    ];
    expect(resolveAcpRunIds(calls, byToolUseId, new Set())).toEqual([
      "acp-shared",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Raw-chip suppression gate
// ---------------------------------------------------------------------------

describe("raw-chip suppression", () => {
  test("a resolved id with a store entry is card-backed", () => {
    act(() => spawn("acp-backed", "tc-1"));
    const byToolUseId = useAcpRunStore.getState().byToolUseId;
    const tc = toolCall({ id: "tc-1", name: "acp_spawn" });
    const id = acpRunIdForCall(tc, byToolUseId);
    expect(id).toBe("acp-backed");
    // Card-backed: a store entry exists for the resolved id.
    expect(useAcpRunStore.getState().byId[id!]).toBeDefined();
  });

  test("a resolved id with NO store entry is not card-backed (chip stays)", () => {
    // Result parse resolves an id, but nothing was spawned into the store.
    const tc = toolCall({
      id: "tc-1",
      name: "acp_spawn",
      result: JSON.stringify({ acpSessionId: "acp-absent" }),
    });
    const id = acpRunIdForCall(tc, useAcpRunStore.getState().byToolUseId);
    expect(id).toBe("acp-absent");
    expect(useAcpRunStore.getState().byId[id!]).toBeUndefined();
  });

  test("a failed call resolving to no id is not card-backed (chip stays)", () => {
    const tc = toolCall({ id: "tc-1", name: "acp_spawn" });
    expect(acpRunIdForCall(tc, useAcpRunStore.getState().byToolUseId)).toBeNull();
  });
});

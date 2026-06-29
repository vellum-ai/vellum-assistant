/**
 * Tests for `BackgroundTaskInlineProgressCard` and its supporting id resolver.
 *
 *  - Card renders running / complete / cancelled / failed states from a seeded
 *    background-task store, plus the start-race `null` fallback and the
 *    header-click + stop callbacks.
 *  - `resolveBackgroundTaskIds` resolves via the result-parse, dedupes through
 *    the caller-owned `claimed` Set, and skips foreground / result-less calls.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";

// The card cancels the task via `stopBackgroundTask`. Mock the action so the
// self-contained path is observable without hitting the daemon client.
const stopBackgroundTaskCalls: string[] = [];
mock.module("@/domains/chat/utils/background-task-actions", () => ({
  stopBackgroundTask: async (id: string) => {
    stopBackgroundTaskCalls.push(id);
  },
}));

import { BackgroundTaskInlineProgressCard } from "@/domains/chat/components/background-task-inline-card/background-task-inline-progress-card";
import { useBackgroundTaskStore } from "@/domains/chat/background-task-store";
import { resolveBackgroundTaskIds } from "@/domains/chat/transcript/transcript-message-body-shared";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";

const NOW = 1700000000000;
const STATUS_TESTID = "background-task-inline-card-status-indicator";
const STOP_TESTID = "background-task-inline-card-stop";

beforeEach(() => {
  useBackgroundTaskStore.getState().reset();
  stopBackgroundTaskCalls.length = 0;
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Store seeding helpers
// ---------------------------------------------------------------------------

function start(id: string, command = "ls -la") {
  useBackgroundTaskStore.getState().startTask({
    type: "background_tool_started",
    id,
    toolName: "bash",
    conversationId: "conv-1",
    command,
    startedAt: NOW,
  });
}

function complete(
  id: string,
  status: "completed" | "failed" | "cancelled",
  exitCode: number | null = 0,
): void {
  useBackgroundTaskStore.getState().completeTask({
    type: "background_tool_completed",
    id,
    conversationId: "conv-1",
    status,
    exitCode,
    completedAt: NOW + 1000,
  });
}

function toolCall(overrides: Partial<ChatMessageToolCall>): ChatMessageToolCall {
  return {
    id: "tc-1",
    name: "bash",
    input: { background: true },
    ...overrides,
  } as ChatMessageToolCall;
}

// ---------------------------------------------------------------------------
// Card render
// ---------------------------------------------------------------------------

describe("BackgroundTaskInlineProgressCard — start race", () => {
  test("renders null when no entry exists in the store yet", () => {
    const { container } = render(
      <BackgroundTaskInlineProgressCard id="missing" />,
    );
    expect(container.firstChild).toBeNull();
  });
});

describe("BackgroundTaskInlineProgressCard — states", () => {
  test("running task shows the three-dot loading indicator and stop button", () => {
    act(() => start("bg-run"));

    const { getByTestId } = render(
      <BackgroundTaskInlineProgressCard id="bg-run" />,
    );

    const indicator = getByTestId(STATUS_TESTID);
    // The loading indicator is the ThreeDotIndicator span (no `data-state`).
    expect(indicator.getAttribute("data-state")).toBeNull();
    expect(getByTestId(STOP_TESTID)).toBeDefined();
  });

  test("renders the command as the header info", () => {
    act(() => start("bg-cmd", "npm run build"));

    const { getAllByText } = render(
      <BackgroundTaskInlineProgressCard id="bg-cmd" />,
    );
    expect(getAllByText("npm run build").length).toBeGreaterThan(0);
  });

  test("completed task renders the complete status icon and no stop button", () => {
    act(() => {
      start("bg-done");
      complete("bg-done", "completed");
    });

    const { getByTestId, queryByTestId } = render(
      <BackgroundTaskInlineProgressCard id="bg-done" />,
    );
    expect(getByTestId(STATUS_TESTID).getAttribute("data-state")).toBe(
      "complete",
    );
    expect(queryByTestId(STOP_TESTID)).toBeNull();
  });

  test("cancelled task renders the warning icon", () => {
    act(() => {
      start("bg-cancel");
      useBackgroundTaskStore.getState().cancelTask("bg-cancel");
    });

    const { getByTestId } = render(
      <BackgroundTaskInlineProgressCard id="bg-cancel" />,
    );
    expect(getByTestId(STATUS_TESTID).getAttribute("data-state")).toBe(
      "warning",
    );
  });

  test("failed task renders the error icon", () => {
    act(() => {
      start("bg-fail");
      complete("bg-fail", "failed", 1);
    });

    const { getByTestId } = render(
      <BackgroundTaskInlineProgressCard id="bg-fail" />,
    );
    expect(getByTestId(STATUS_TESTID).getAttribute("data-state")).toBe("error");
  });
});

describe("BackgroundTaskInlineProgressCard — interaction", () => {
  test("clicking the header row invokes onClick with the task id", () => {
    act(() => start("bg-open"));
    const seen: string[] = [];
    const { getByRole } = render(
      <BackgroundTaskInlineProgressCard
        id="bg-open"
        onClick={(id) => seen.push(id)}
      />,
    );
    fireEvent.click(getByRole("button", { name: /open command/i }));
    expect(seen).toEqual(["bg-open"]);
  });

  test("stop button cancels via stopBackgroundTask and disables after click", () => {
    act(() => start("bg-stop"));
    const { getByTestId } = render(
      <BackgroundTaskInlineProgressCard id="bg-stop" />,
    );
    const button = getByTestId(STOP_TESTID);
    fireEvent.click(button);
    expect(stopBackgroundTaskCalls).toEqual(["bg-stop"]);
    expect(button.hasAttribute("disabled")).toBe(true);
  });

  test("stop button disappears once the task reaches a terminal status", () => {
    act(() => start("bg-terminal"));
    const { getByTestId, queryByTestId } = render(
      <BackgroundTaskInlineProgressCard id="bg-terminal" />,
    );
    fireEvent.click(getByTestId(STOP_TESTID));
    expect(stopBackgroundTaskCalls).toEqual(["bg-terminal"]);

    act(() => complete("bg-terminal", "cancelled"));
    expect(queryByTestId(STOP_TESTID)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveBackgroundTaskIds
// ---------------------------------------------------------------------------

describe("resolveBackgroundTaskIds", () => {
  test("resolves the bg id from a backgrounded call's result", () => {
    const tc = toolCall({
      result: JSON.stringify({ backgrounded: true, id: "bg-1" }),
    });
    expect(resolveBackgroundTaskIds([tc], new Set())).toEqual(["bg-1"]);
  });

  test("skips a foreground bash call", () => {
    const tc = toolCall({
      input: { background: false },
      result: JSON.stringify({ backgrounded: true, id: "bg-2" }),
    });
    expect(resolveBackgroundTaskIds([tc], new Set())).toEqual([]);
  });

  test("skips a backgrounded call whose result hasn't landed", () => {
    expect(resolveBackgroundTaskIds([toolCall({})], new Set())).toEqual([]);
  });

  test("claimed set prevents two calls anchoring the same id", () => {
    const calls = [
      toolCall({
        id: "tc-1",
        result: JSON.stringify({ backgrounded: true, id: "bg-shared" }),
      }),
      toolCall({
        id: "tc-2",
        result: JSON.stringify({ backgrounded: true, id: "bg-shared" }),
      }),
    ];
    expect(resolveBackgroundTaskIds(calls, new Set())).toEqual(["bg-shared"]);
  });
});

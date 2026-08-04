/**
 * Tests for `useConversationActivity`, the conversation-scoped subagent + ACP
 * feed behind the header Activity control.
 *
 * Covers the three things the control depends on:
 *  - conversation scoping (another conversation's work never leaks in),
 *  - the running/completed split,
 *  - the cross-kind merge and its ordering.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import { useAcpRunStore } from "@/domains/chat/acp-run-store";
import { useConversationActivity } from "@/domains/chat/hooks/use-conversation-activity";
import { useSubagentStore } from "@/domains/chat/subagent-store";

import type { ConversationActivity } from "@/domains/chat/hooks/use-conversation-activity";

const CONV = "conv-A";
const OTHER = "conv-B";
const T0 = 1_700_000_000_000;

afterEach(() => {
  cleanup();
  useSubagentStore.getState().reset();
  useAcpRunStore.getState().reset();
});

/** Render the hook for `conversationId` and return its latest result. */
function readActivity(conversationId: string | null): ConversationActivity {
  let latest: ConversationActivity | null = null;
  function Harness() {
    latest = useConversationActivity(conversationId);
    return null;
  }
  render(<Harness />);
  if (!latest) {
    throw new Error("hook did not produce a result");
  }
  return latest;
}

function spawnSubagent(
  subagentId: string,
  status: "running" | "completed",
  parentConversationId: string | undefined,
  timestamp: number,
) {
  useSubagentStore.getState().spawnSubagent({
    subagentId,
    label: subagentId,
    objective: "",
    status,
    parentConversationId,
    timestamp,
  });
}

function spawnAcpRun(
  acpSessionId: string,
  parentConversationId: string,
  startedAt: number,
  terminal?: boolean,
) {
  useAcpRunStore.getState().spawnRun({
    acpSessionId,
    agent: "claude",
    parentConversationId,
    startedAt,
  });
  if (terminal) {
    useAcpRunStore.getState().setTerminal({
      acpSessionId,
      status: "completed",
      completedAt: startedAt + 1_000,
    });
  }
}

describe("useConversationActivity: conversation scoping", () => {
  test("excludes subagents and runs owned by another conversation", () => {
    spawnSubagent("sa-mine", "running", CONV, T0);
    spawnSubagent("sa-theirs", "running", OTHER, T0 + 1);
    spawnAcpRun("acp-mine", CONV, T0 + 2);
    spawnAcpRun("acp-theirs", OTHER, T0 + 3);

    const { running, completed, total } = readActivity(CONV);

    expect(running.map((r) => r.id)).toEqual(["sa-mine", "acp-mine"]);
    expect(completed).toEqual([]);
    expect(total).toBe(2);
  });

  test("drops a finished ACP run that carries no owning conversation", () => {
    // Rehydration stamps `parentConversationId: ""` for a persisted row with no
    // parent, and the ACP store is never reset between conversations. Treating
    // that as a match would pin the run to every conversation for the rest of
    // the session.
    useAcpRunStore.getState().spawnRun({
      acpSessionId: "acp-orphan",
      agent: "claude",
      parentConversationId: "",
      startedAt: T0,
    });
    useAcpRunStore.getState().setTerminal({
      acpSessionId: "acp-orphan",
      status: "completed",
      completedAt: T0 + 10,
    });

    const activity = readActivity(CONV);

    expect(activity.completed).toEqual([]);
    expect(activity.total).toBe(0);
  });

  test("keeps a subagent whose parent conversation is not yet known", () => {
    // Mirrors `useActiveSubagentIds`: an unplaceable entry stays visible rather
    // than disappearing from every conversation at once.
    spawnSubagent("sa-unparented", "running", undefined, T0);

    expect(readActivity(CONV).running.map((r) => r.id)).toEqual([
      "sa-unparented",
    ]);
  });
});

describe("useConversationActivity: running/completed split", () => {
  test("routes each process by status", () => {
    spawnSubagent("sa-running", "running", CONV, T0);
    spawnSubagent("sa-done", "completed", CONV, T0 + 1);
    spawnAcpRun("acp-running", CONV, T0 + 2);
    spawnAcpRun("acp-done", CONV, T0 + 3, true);

    const { running, completed, total } = readActivity(CONV);

    expect(running.map((r) => r.id).sort()).toEqual([
      "acp-running",
      "sa-running",
    ]);
    expect(completed.map((r) => r.id).sort()).toEqual(["acp-done", "sa-done"]);
    expect(total).toBe(4);
  });

  test("reports nothing for a conversation with no activity", () => {
    spawnSubagent("sa-theirs", "running", OTHER, T0);

    const activity = readActivity(CONV);

    expect(activity.total).toBe(0);
    expect(activity.running).toEqual([]);
    expect(activity.completed).toEqual([]);
  });
});

describe("useConversationActivity: ordering", () => {
  test("merges the two kinds by start time rather than grouping by kind", () => {
    spawnAcpRun("acp-first", CONV, T0);
    spawnSubagent("sa-second", "running", CONV, T0 + 100);
    spawnAcpRun("acp-third", CONV, T0 + 200);

    expect(readActivity(CONV).running.map((r) => r.id)).toEqual([
      "acp-first",
      "sa-second",
      "acp-third",
    ]);
  });

  test("lists finished work most-recent-first", () => {
    spawnSubagent("sa-older", "completed", CONV, T0);
    spawnAcpRun("acp-newest", CONV, T0 + 200, true);
    spawnSubagent("sa-newer", "completed", CONV, T0 + 100);

    expect(readActivity(CONV).completed.map((r) => r.id)).toEqual([
      "acp-newest",
      "sa-newer",
      "sa-older",
    ]);
  });
});

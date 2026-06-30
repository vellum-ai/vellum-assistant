/**
 * Tests for `fetchBackgroundTasks` + `applyBackgroundTaskSnapshot`. We mock the
 * generated `backgroundtoolsGet` SDK fn so we can stage `background-tools`
 * responses and assert the rehydrated entries plus the known-vs-in-flight
 * retirement logic.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

interface FakeRequest {
  path?: Record<string, string>;
  query?: Record<string, unknown>;
}

interface FakeResponse {
  status: number;
  body?: unknown;
}

const requests: FakeRequest[] = [];
let nextResponses: FakeResponse[] = [];

mock.module("@/generated/daemon/sdk.gen", () => ({
  backgroundtoolsGet: async ({
    path,
    query,
  }: {
    path?: Record<string, string>;
    query?: Record<string, unknown>;
    throwOnError?: boolean;
  }) => {
    requests.push({ path, query });
    const next = nextResponses.shift();
    if (!next) throw new Error("No staged response for backgroundtoolsGet");
    const response = {
      status: next.status,
      ok: next.status >= 200 && next.status < 300,
    };
    return { data: next.body, response };
  },
}));

mock.module("@/lib/sentry/capture-error", () => ({
  captureError: () => {},
}));

// Subject imported after mocks.
import {
  applyBackgroundTaskSnapshot,
  fetchBackgroundTasks,
} from "@/domains/chat/hooks/use-background-task-rehydration";
import {
  useBackgroundTaskStore,
  type BackgroundTaskEntry,
} from "@/domains/chat/background-task-store";

const NOW = 1700000000000;

function getState() {
  return useBackgroundTaskStore.getState();
}

function toolRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "bg-1",
    toolName: "bash",
    conversationId: "conv-1",
    command: "sleep 10",
    startedAt: NOW,
    ...overrides,
  };
}

function completedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "bg-1",
    toolName: "bash",
    conversationId: "conv-1",
    command: "sleep 10",
    startedAt: NOW,
    status: "completed",
    exitCode: 0,
    output: "done",
    completedAt: NOW + 1000,
    ...overrides,
  };
}

function runningEntry(
  id: string,
  conversationId = "conv-1",
): BackgroundTaskEntry {
  return {
    id,
    toolName: "bash",
    conversationId,
    command: "sleep 10",
    startedAt: NOW,
    status: "running",
  };
}

function completedEntry(
  id: string,
  status: "completed" | "failed" | "cancelled" = "completed",
): BackgroundTaskEntry {
  return {
    id,
    toolName: "bash",
    conversationId: "conv-1",
    command: "sleep 10",
    startedAt: NOW,
    status,
    exitCode: status === "completed" ? 0 : 1,
    output: "done",
    completedAt: NOW + 1000,
  };
}

const EMPTY_SNAPSHOT = { active: [], completed: [] };

beforeEach(() => {
  requests.length = 0;
  nextResponses = [];
  getState().reset();
});

afterEach(() => {
  getState().reset();
});

describe("fetchBackgroundTasks", () => {
  test("requests the assistant-scoped route filtered by conversation", async () => {
    nextResponses = [{ status: 200, body: { tools: [], completed: [] } }];
    await fetchBackgroundTasks("asst-1", "conv-1");

    expect(requests).toHaveLength(1);
    expect(requests[0]!.path).toEqual({ assistant_id: "asst-1" });
    expect(requests[0]!.query).toEqual({ conversationId: "conv-1" });
  });

  test("maps returned tools to running entries", async () => {
    nextResponses = [{ status: 200, body: { tools: [toolRow()], completed: [] } }];
    const snapshot = await fetchBackgroundTasks("asst-1", "conv-1");

    expect(snapshot).toEqual({
      active: [
        {
          id: "bg-1",
          toolName: "bash",
          conversationId: "conv-1",
          command: "sleep 10",
          startedAt: NOW,
          status: "running",
        },
      ],
      completed: [],
    });
  });

  test("maps the completed ring to terminal entries", async () => {
    nextResponses = [
      { status: 200, body: { tools: [], completed: [completedRow()] } },
    ];
    const snapshot = await fetchBackgroundTasks("asst-1", "conv-1");

    expect(snapshot?.completed).toEqual([
      {
        id: "bg-1",
        toolName: "bash",
        conversationId: "conv-1",
        command: "sleep 10",
        startedAt: NOW,
        status: "completed",
        exitCode: 0,
        output: "done",
        completedAt: NOW + 1000,
      },
    ]);
  });

  test("tolerates a response without a completed field", async () => {
    nextResponses = [{ status: 200, body: { tools: [toolRow()] } }];
    const snapshot = await fetchBackgroundTasks("asst-1", "conv-1");
    expect(snapshot?.completed).toEqual([]);
  });

  test("returns null on a non-ok response (distinct from an empty snapshot)", async () => {
    nextResponses = [{ status: 500, body: null }];
    expect(await fetchBackgroundTasks("asst-1", "conv-1")).toBeNull();
  });
});

describe("rehydration", () => {
  test("a list response seeds running entries", async () => {
    nextResponses = [{ status: 200, body: { tools: [toolRow()], completed: [] } }];
    const snapshot = await fetchBackgroundTasks("asst-1", "conv-1");
    applyBackgroundTaskSnapshot(snapshot, []);

    const entry = getState().byId["bg-1"]!;
    expect(entry.status).toBe("running");
    expect(entry.command).toBe("sleep 10");
    expect(getState().orderedIds).toContain("bg-1");
  });

  test("retires a known task absent from the snapshot", () => {
    getState().seedFromHistory([runningEntry("bg-1")]);
    // bg-1 existed before the fetch and the daemon reports it in neither list.
    applyBackgroundTaskSnapshot(EMPTY_SNAPSHOT, ["bg-1"]);

    expect(getState().byId["bg-1"]!.status).toBe("cancelled");
  });

  test("settles a known task reported in the completed ring instead of cancelling it", () => {
    // bg-1 was running in the store; it finished while the chat was unmounted,
    // so the daemon reports it under `completed`, not `tools`. A completed-ring
    // entry must settle the task to its real terminal status before retirement
    // runs, so an absent-from-active task that actually finished is not retired
    // as a false `cancelled`.
    getState().seedFromHistory([runningEntry("bg-1")]);
    applyBackgroundTaskSnapshot(
      { active: [], completed: [completedEntry("bg-1", "completed")] },
      ["bg-1"],
    );

    const entry = getState().byId["bg-1"]!;
    expect(entry.status).toBe("completed");
    expect(entry.exitCode).toBe(0);
    expect(entry.output).toBe("done");
  });

  test("seeds a completed task the store never saw (different conversation active)", () => {
    // The store was never seeded for bg-9 (the page opened on another
    // conversation), but the daemon's completed ring carries it. Rehydrating
    // creates the settled entry rather than leaving the result as raw JSON.
    applyBackgroundTaskSnapshot(
      { active: [], completed: [completedEntry("bg-9", "failed")] },
      [],
    );

    const entry = getState().byId["bg-9"]!;
    expect(entry.status).toBe("failed");
    expect(entry.output).toBe("done");
  });

  test("leaves an in-flight-started (not-known) task running", () => {
    // bg-2 started after the snapshot was captured: in the store but absent
    // from `knownIds`, so retirement must skip it.
    getState().seedFromHistory([runningEntry("bg-2")]);
    applyBackgroundTaskSnapshot(EMPTY_SNAPSHOT, []);

    expect(getState().byId["bg-2"]!.status).toBe("running");
  });

  test("keeps a task still reported by the snapshot running", () => {
    getState().seedFromHistory([runningEntry("bg-1")]);
    applyBackgroundTaskSnapshot(
      { active: [runningEntry("bg-1")], completed: [] },
      ["bg-1"],
    );

    expect(getState().byId["bg-1"]!.status).toBe("running");
  });

  test("a null snapshot (failed fetch) reconciles nothing", () => {
    getState().seedFromHistory([runningEntry("bg-1")]);
    applyBackgroundTaskSnapshot(null, ["bg-1"]);

    expect(getState().byId["bg-1"]!.status).toBe("running");
  });
});

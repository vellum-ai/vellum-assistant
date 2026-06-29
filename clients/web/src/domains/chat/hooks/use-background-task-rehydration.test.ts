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
    nextResponses = [{ status: 200, body: { tools: [] } }];
    await fetchBackgroundTasks("asst-1", "conv-1");

    expect(requests).toHaveLength(1);
    expect(requests[0]!.path).toEqual({ assistant_id: "asst-1" });
    expect(requests[0]!.query).toEqual({ conversationId: "conv-1" });
  });

  test("maps returned tools to running entries", async () => {
    nextResponses = [{ status: 200, body: { tools: [toolRow()] } }];
    const entries = await fetchBackgroundTasks("asst-1", "conv-1");

    expect(entries).toEqual([
      {
        id: "bg-1",
        toolName: "bash",
        conversationId: "conv-1",
        command: "sleep 10",
        startedAt: NOW,
        status: "running",
      },
    ]);
  });

  test("returns null on a non-ok response (distinct from an empty snapshot)", async () => {
    nextResponses = [{ status: 500, body: null }];
    expect(await fetchBackgroundTasks("asst-1", "conv-1")).toBeNull();
  });
});

describe("rehydration", () => {
  test("a list response seeds running entries", async () => {
    nextResponses = [{ status: 200, body: { tools: [toolRow()] } }];
    const entries = await fetchBackgroundTasks("asst-1", "conv-1");
    applyBackgroundTaskSnapshot(entries, []);

    const entry = getState().byId["bg-1"]!;
    expect(entry.status).toBe("running");
    expect(entry.command).toBe("sleep 10");
    expect(getState().orderedIds).toContain("bg-1");
  });

  test("retires a known task absent from the snapshot", () => {
    getState().seedFromHistory([runningEntry("bg-1")]);
    // bg-1 existed before the fetch and the daemon no longer reports it.
    applyBackgroundTaskSnapshot([], ["bg-1"]);

    expect(getState().byId["bg-1"]!.status).toBe("cancelled");
  });

  test("leaves an in-flight-started (not-known) task running", () => {
    // bg-2 started after the snapshot was captured: in the store but absent
    // from `knownIds`, so retirement must skip it.
    getState().seedFromHistory([runningEntry("bg-2")]);
    applyBackgroundTaskSnapshot([], []);

    expect(getState().byId["bg-2"]!.status).toBe("running");
  });

  test("keeps a task still reported by the snapshot running", () => {
    getState().seedFromHistory([runningEntry("bg-1")]);
    applyBackgroundTaskSnapshot([runningEntry("bg-1")], ["bg-1"]);

    expect(getState().byId["bg-1"]!.status).toBe("running");
  });

  test("a null snapshot (failed fetch) reconciles nothing", () => {
    getState().seedFromHistory([runningEntry("bg-1")]);
    applyBackgroundTaskSnapshot(null, ["bg-1"]);

    expect(getState().byId["bg-1"]!.status).toBe("running");
  });
});

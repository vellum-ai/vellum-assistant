/**
 * Tests for the background-task actions (stop).
 *
 * `stopBackgroundTask` calls the generated `backgroundtoolsCancelPost`, which
 * answers 200 with `{ cancelled: boolean }`. Mock the SDK to stage that body and
 * assert the optimistic-cancel / rollback behavior.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { BackgroundTaskEntry } from "@/domains/chat/background-task-store";

interface CancelCall {
  path?: Record<string, string>;
  body?: Record<string, unknown>;
}

const calls: CancelCall[] = [];
let nextData: { cancelled: boolean } | undefined = { cancelled: true };
let nextOk = true;
let nextStatus = 200;

// Stub the generated cancel SDK to stage the `{ cancelled }` body. Tests run one
// file per subprocess (`test:ci` / `run-tests.ts`) so this module replacement is
// isolated, matching `acp-run-actions.test.ts`.
mock.module("@/generated/daemon/sdk.gen", () => ({
  backgroundtoolsCancelPost: async (options: CancelCall) => {
    calls.push(options);
    return { data: nextData, response: { ok: nextOk, status: nextStatus } };
  },
}));

const { useResolvedAssistantsStore } = await import(
  "@/stores/resolved-assistants-store"
);
const { useBackgroundTaskStore } = await import(
  "@/domains/chat/background-task-store"
);
const { stopBackgroundTask } = await import(
  "@/domains/chat/utils/background-task-actions"
);

function seedRunning(id = "bg-1"): void {
  const entry: BackgroundTaskEntry = {
    id,
    toolName: "bash",
    conversationId: "conv-1",
    command: "npm run build",
    startedAt: 1,
    status: "running",
  };
  useBackgroundTaskStore.getState().reset();
  useBackgroundTaskStore.getState().seedFromHistory([entry]);
}

beforeEach(() => {
  calls.length = 0;
  nextData = { cancelled: true };
  nextOk = true;
  nextStatus = 200;
  useResolvedAssistantsStore.setState({ activeAssistantId: "asst-1" });
});

afterEach(() => {
  useResolvedAssistantsStore.setState({ activeAssistantId: null });
  useBackgroundTaskStore.getState().reset();
});

describe("stopBackgroundTask", () => {
  test("POSTs the cancel route with the assistant + task id", async () => {
    seedRunning();
    await stopBackgroundTask("bg-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toEqual({ assistant_id: "asst-1" });
    expect(calls[0]!.body).toEqual({ id: "bg-1" });
  });

  test("optimistically marks the active task cancelled", async () => {
    seedRunning();
    await stopBackgroundTask("bg-1");
    expect(useBackgroundTaskStore.getState().byId["bg-1"]!.status).toBe(
      "cancelled",
    );
  });

  test("rolls back the optimistic cancel when the daemon reports cancelled:false", async () => {
    seedRunning();
    nextData = { cancelled: false };

    await expect(stopBackgroundTask("bg-1")).rejects.toThrow();

    // The task was already gone — restored to running so the Stop control
    // reappears, not left stuck cancelled.
    const entry = useBackgroundTaskStore.getState().byId["bg-1"]!;
    expect(entry.status).toBe("running");
    expect(entry.completedAt).toBeUndefined();
  });

  test("rolls back the optimistic cancel when the request fails", async () => {
    seedRunning();
    nextOk = false;
    nextStatus = 500;

    await expect(stopBackgroundTask("bg-1")).rejects.toThrow();

    expect(useBackgroundTaskStore.getState().byId["bg-1"]!.status).toBe(
      "running",
    );
  });

  test("does not optimistically cancel when there is no active assistant", async () => {
    seedRunning();
    useResolvedAssistantsStore.setState({ activeAssistantId: null });

    await expect(stopBackgroundTask("bg-1")).rejects.toThrow(
      "No active assistant",
    );

    expect(useBackgroundTaskStore.getState().byId["bg-1"]!.status).toBe(
      "running",
    );
    expect(calls).toHaveLength(0);
  });
});

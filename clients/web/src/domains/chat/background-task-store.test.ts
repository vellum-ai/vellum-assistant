import { beforeEach, describe, expect, it } from "bun:test";
import type {
  BackgroundToolCompletedEvent,
  BackgroundToolStartedEvent,
} from "@vellumai/assistant-api";
import {
  useBackgroundTaskStore,
  type BackgroundTaskEntry,
} from "@/domains/chat/background-task-store";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getState() {
  return useBackgroundTaskStore.getState();
}

const NOW = 1700000000000;

function startedEvent(
  overrides: Partial<BackgroundToolStartedEvent> = {},
): BackgroundToolStartedEvent {
  return {
    type: "background_tool_started",
    id: "bg-1",
    toolName: "bash",
    conversationId: "conv-1",
    command: "sleep 10",
    startedAt: NOW,
    ...overrides,
  };
}

function completedEvent(
  overrides: Partial<BackgroundToolCompletedEvent> = {},
): BackgroundToolCompletedEvent {
  return {
    type: "background_tool_completed",
    id: "bg-1",
    conversationId: "conv-1",
    status: "completed",
    exitCode: 0,
    output: "done",
    completedAt: NOW + 1000,
    ...overrides,
  };
}

function historyEntry(
  overrides: Partial<BackgroundTaskEntry> = {},
): BackgroundTaskEntry {
  return {
    id: "bg-1",
    toolName: "bash",
    conversationId: "conv-1",
    command: "sleep 10",
    startedAt: NOW,
    status: "completed",
    ...overrides,
  };
}

beforeEach(() => {
  getState().reset();
});

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

describe("initial state", () => {
  it("starts empty", () => {
    expect(getState().byId).toEqual({});
    expect(getState().orderedIds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// startTask
// ---------------------------------------------------------------------------

describe("startTask", () => {
  it("adds a running entry with the event metadata", () => {
    getState().startTask(startedEvent({ command: "npm run build" }));

    const entry = getState().byId["bg-1"]!;
    expect(getState().orderedIds).toEqual(["bg-1"]);
    expect(entry.toolName).toBe("bash");
    expect(entry.conversationId).toBe("conv-1");
    expect(entry.command).toBe("npm run build");
    expect(entry.startedAt).toBe(NOW);
    expect(entry.status).toBe("running");
    expect(entry.exitCode).toBeUndefined();
    expect(entry.output).toBeUndefined();
    expect(entry.completedAt).toBeUndefined();
  });

  it("is idempotent — a replayed start with the same id is ignored", () => {
    getState().startTask(startedEvent());
    getState().startTask(
      startedEvent({ command: "replayed", startedAt: NOW + 5000 }),
    );

    expect(getState().orderedIds).toEqual(["bg-1"]);
    expect(getState().byId["bg-1"]!.command).toBe("sleep 10");
    expect(getState().byId["bg-1"]!.startedAt).toBe(NOW);
  });

  it("preserves insertion order across multiple starts", () => {
    getState().startTask(startedEvent({ id: "bg-a" }));
    getState().startTask(startedEvent({ id: "bg-b" }));
    getState().startTask(startedEvent({ id: "bg-c" }));

    expect(getState().orderedIds).toEqual(["bg-a", "bg-b", "bg-c"]);
  });
});

// ---------------------------------------------------------------------------
// completeTask
// ---------------------------------------------------------------------------

describe("completeTask", () => {
  it("settles a running task with status, exit code, output, and time", () => {
    getState().startTask(startedEvent());
    getState().completeTask(
      completedEvent({ exitCode: 0, output: "build ok", completedAt: NOW + 1500 }),
    );

    const entry = getState().byId["bg-1"]!;
    expect(entry.status).toBe("completed");
    expect(entry.exitCode).toBe(0);
    expect(entry.output).toBe("build ok");
    expect(entry.completedAt).toBe(NOW + 1500);
  });

  it("records a failing exit code on a failed task", () => {
    getState().startTask(startedEvent());
    getState().completeTask(
      completedEvent({ status: "failed", exitCode: 1, output: "boom" }),
    );

    const entry = getState().byId["bg-1"]!;
    expect(entry.status).toBe("failed");
    expect(entry.exitCode).toBe(1);
    expect(entry.output).toBe("boom");
  });

  it("does not regress an optimistically-cancelled task to failed", () => {
    getState().startTask(startedEvent());
    getState().cancelTask("bg-1");
    expect(getState().byId["bg-1"]!.status).toBe("cancelled");

    // The daemon's cancellation emits a failed terminal — status stays cancelled
    // but the captured output/exit code still land.
    getState().completeTask(
      completedEvent({ status: "failed", exitCode: 143, output: "killed", completedAt: NOW + 2000 }),
    );

    const entry = getState().byId["bg-1"]!;
    expect(entry.status).toBe("cancelled");
    expect(entry.exitCode).toBe(143);
    expect(entry.output).toBe("killed");
    expect(entry.completedAt).toBe(NOW + 2000);
  });

  it("ignores an unknown id", () => {
    getState().completeTask(completedEvent({ id: "bg-missing" }));
    expect(getState().byId).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// cancelTask
// ---------------------------------------------------------------------------

describe("cancelTask", () => {
  it("marks a running task cancelled", () => {
    getState().startTask(startedEvent());
    getState().cancelTask("bg-1");

    expect(getState().byId["bg-1"]!.status).toBe("cancelled");
  });

  it("does not regress an already-terminal task", () => {
    getState().startTask(startedEvent());
    getState().completeTask(completedEvent({ status: "completed" }));
    getState().cancelTask("bg-1");

    expect(getState().byId["bg-1"]!.status).toBe("completed");
  });

  it("ignores an unknown id", () => {
    getState().cancelTask("bg-missing");
    expect(getState().byId).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// restoreTaskStatus
// ---------------------------------------------------------------------------

describe("restoreTaskStatus", () => {
  it("reverts an optimistic cancel to the prior status and clears completedAt", () => {
    getState().startTask(startedEvent());
    getState().cancelTask("bg-1");
    expect(getState().byId["bg-1"]!.status).toBe("cancelled");

    getState().restoreTaskStatus("bg-1", "running");

    expect(getState().byId["bg-1"]!.status).toBe("running");
    expect(getState().byId["bg-1"]!.completedAt).toBeUndefined();
  });

  it("is a no-op once a real terminal has landed (never regresses to active)", () => {
    getState().startTask(startedEvent());
    getState().completeTask(completedEvent({ status: "completed" }));
    getState().restoreTaskStatus("bg-1", "running");

    expect(getState().byId["bg-1"]!.status).toBe("completed");
  });

  it("is a no-op when a terminal completion raced in after the optimistic cancel", () => {
    getState().startTask(startedEvent());
    getState().cancelTask("bg-1");
    // A failed terminal races in before the cancel request reports: it settles
    // the entry (sets completedAt) while preserving the "cancelled" status.
    getState().completeTask(
      completedEvent({ status: "failed", exitCode: 143, output: "killed", completedAt: NOW + 2000 }),
    );
    expect(getState().byId["bg-1"]!.completedAt).toBe(NOW + 2000);

    // The cancel request later fails — restore must NOT revive the settled task.
    getState().restoreTaskStatus("bg-1", "running");

    const entry = getState().byId["bg-1"]!;
    expect(entry.status).toBe("cancelled");
    expect(entry.completedAt).toBe(NOW + 2000);
  });

  it("ignores an unknown id", () => {
    getState().restoreTaskStatus("bg-missing", "running");
    expect(getState().byId).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// retireMissing
// ---------------------------------------------------------------------------

describe("retireMissing", () => {
  it("cancels running tasks absent from the active snapshot", () => {
    getState().startTask(startedEvent({ id: "bg-1" }));
    getState().startTask(startedEvent({ id: "bg-2" }));

    // Both were known when the snapshot was taken; only bg-1 is still active in
    // it — bg-2 is retired.
    getState().retireMissing(["bg-1"], ["bg-1", "bg-2"]);

    expect(getState().byId["bg-1"]!.status).toBe("running");
    expect(getState().byId["bg-2"]!.status).toBe("cancelled");
  });

  it("leaves an already-terminal task untouched", () => {
    getState().startTask(startedEvent());
    getState().completeTask(completedEvent({ status: "completed" }));
    getState().retireMissing([], ["bg-1"]);

    expect(getState().byId["bg-1"]!.status).toBe("completed");
  });

  it("does not touch state when every running task is still active", () => {
    getState().startTask(startedEvent());
    const before = getState().byId;
    getState().retireMissing(["bg-1"], ["bg-1"]);
    expect(getState().byId).toBe(before);
  });

  it("leaves a task started after the snapshot (not in knownIds) untouched", () => {
    getState().startTask(startedEvent({ id: "bg-known" }));
    getState().startTask(startedEvent({ id: "bg-new" }));

    // Snapshot knew only bg-known; bg-new started while the fetch was in flight.
    // Neither is in the active set, but only the known one is retired.
    getState().retireMissing([], ["bg-known"]);

    expect(getState().byId["bg-known"]!.status).toBe("cancelled");
    expect(getState().byId["bg-new"]!.status).toBe("running");
  });
});

// ---------------------------------------------------------------------------
// seedFromHistory
// ---------------------------------------------------------------------------

describe("seedFromHistory", () => {
  it("adds new entries and ordered ids", () => {
    getState().seedFromHistory([
      historyEntry({ id: "bg-h1", status: "completed", exitCode: 0, output: "ok" }),
    ]);

    expect(getState().orderedIds).toEqual(["bg-h1"]);
    const entry = getState().byId["bg-h1"]!;
    expect(entry.status).toBe("completed");
    expect(entry.output).toBe("ok");
  });

  it("is idempotent — re-seeding the same entry does not duplicate ordered ids", () => {
    const entry = historyEntry({ id: "bg-h1" });
    getState().seedFromHistory([entry]);
    getState().seedFromHistory([entry]);

    expect(getState().orderedIds).toEqual(["bg-h1"]);
  });

  it("folds a terminal history status onto a live running entry", () => {
    getState().startTask(startedEvent());
    expect(getState().byId["bg-1"]!.status).toBe("running");

    getState().seedFromHistory([
      historyEntry({ status: "completed", exitCode: 0, output: "done", completedAt: NOW + 3000 }),
    ]);

    const entry = getState().byId["bg-1"]!;
    expect(entry.status).toBe("completed");
    expect(entry.output).toBe("done");
    expect(entry.completedAt).toBe(NOW + 3000);
  });

  it("does not regress a live terminal entry with a non-terminal history status", () => {
    getState().startTask(startedEvent());
    getState().completeTask(
      completedEvent({ status: "completed", exitCode: 0, output: "done", completedAt: NOW + 1000 }),
    );

    getState().seedFromHistory([
      historyEntry({ status: "running", exitCode: undefined, output: undefined }),
    ]);

    const entry = getState().byId["bg-1"]!;
    expect(entry.status).toBe("completed");
    expect(entry.completedAt).toBe(NOW + 1000);
    expect(entry.output).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// reset
// ---------------------------------------------------------------------------

describe("reset", () => {
  it("clears all state back to initial", () => {
    getState().startTask(startedEvent());
    getState().completeTask(completedEvent());

    getState().reset();

    expect(getState().byId).toEqual({});
    expect(getState().orderedIds).toEqual([]);
  });
});

import { afterEach, describe, expect, it } from "bun:test";

import { makeCtx } from "@/domains/chat/utils/stream-handlers/test-helpers";
import { useWorkflowStore } from "@/domains/chat/workflow-store";
import {
  handleWorkflowStarted,
  handleWorkflowProgress,
  handleWorkflowLeafStarted,
  handleWorkflowLeafFinished,
  handleWorkflowCompleted,
} from "@/domains/chat/utils/stream-handlers/workflow-handlers";

afterEach(() => {
  useWorkflowStore.getState().reset();
});

describe("handleWorkflowStarted", () => {
  it("creates a running run entry", () => {
    handleWorkflowStarted(
      {
        type: "workflow_started",
        runId: "run-1",
        conversationId: "conv-1",
        toolUseId: "tool-1",
        label: "Build feature",
      },
      makeCtx(),
    );

    const entry = useWorkflowStore.getState().byId["run-1"];
    expect(entry).toBeDefined();
    expect(entry?.status).toBe("running");
    expect(entry?.label).toBe("Build feature");
    expect(entry?.toolUseId).toBe("tool-1");
    expect(useWorkflowStore.getState().byToolUseId.get("tool-1")).toBe("run-1");
  });
});

describe("handleWorkflowProgress", () => {
  it("applies phase, agentsSpawned, and the log message to the run", () => {
    handleWorkflowProgress(
      {
        type: "workflow_progress",
        runId: "run-1",
        conversationId: "conv-1",
        agentsSpawned: 3,
        phase: "fan-out",
        label: "Build feature",
        message: "spawning",
      },
      makeCtx(),
    );

    const entry = useWorkflowStore.getState().byId["run-1"];
    expect(entry?.agentsSpawned).toBe(3);
    expect(entry?.phase).toBe("fan-out");
    expect(entry?.message).toBe("spawning");
  });
});

describe("handleWorkflowLeafStarted", () => {
  it("records a running leaf keyed by seq", () => {
    handleWorkflowLeafStarted(
      {
        type: "workflow_leaf_started",
        runId: "run-1",
        conversationId: "conv-1",
        seq: 0,
        label: "Leaf A",
        phase: "work",
        promptSummary: "do a thing",
      },
      makeCtx(),
    );

    const leaf = useWorkflowStore.getState().byId["run-1"]?.leaves.get(0);
    expect(leaf?.status).toBe("running");
    expect(leaf?.label).toBe("Leaf A");
    expect(leaf?.promptSummary).toBe("do a thing");
  });
});

describe("handleWorkflowLeafFinished", () => {
  it("marks the leaf terminal with token counts", () => {
    const ctx = makeCtx();
    handleWorkflowLeafStarted(
      {
        type: "workflow_leaf_started",
        runId: "run-1",
        conversationId: "conv-1",
        seq: 0,
        label: "Leaf A",
      },
      ctx,
    );
    handleWorkflowLeafFinished(
      {
        type: "workflow_leaf_finished",
        runId: "run-1",
        conversationId: "conv-1",
        seq: 0,
        status: "completed",
        inputTokens: 10,
        outputTokens: 20,
        resultSummary: "done",
      },
      ctx,
    );

    const leaf = useWorkflowStore.getState().byId["run-1"]?.leaves.get(0);
    expect(leaf?.status).toBe("completed");
    expect(leaf?.inputTokens).toBe(10);
    expect(leaf?.outputTokens).toBe(20);
    expect(leaf?.resultSummary).toBe("done");
  });
});

describe("handleWorkflowCompleted", () => {
  it("sets the terminal run status and totals", () => {
    handleWorkflowCompleted(
      {
        type: "workflow_completed",
        runId: "run-1",
        conversationId: "conv-1",
        status: "completed",
        agentsSpawned: 4,
        inputTokens: 100,
        outputTokens: 200,
        summary: "all done",
      },
      makeCtx(),
    );

    const entry = useWorkflowStore.getState().byId["run-1"];
    expect(entry?.status).toBe("completed");
    expect(entry?.agentsSpawned).toBe(4);
    expect(entry?.inputTokens).toBe(100);
    expect(entry?.outputTokens).toBe(200);
    expect(entry?.summary).toBe("all done");
  });
});

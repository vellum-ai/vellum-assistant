import { beforeEach, describe, expect, it } from "bun:test";

import { useBackgroundTaskStore } from "@/domains/chat/background-task-store";
import {
  handleBackgroundToolStarted,
  handleBackgroundToolCompleted,
} from "@/domains/chat/utils/stream-handlers/background-task-handlers";

function getState() {
  return useBackgroundTaskStore.getState();
}

function start() {
  handleBackgroundToolStarted({
    type: "background_tool_started",
    id: "bg-1",
    toolName: "bash",
    conversationId: "conv-1",
    command: "sleep 5",
    startedAt: 1000,
  });
}

beforeEach(() => {
  getState().reset();
});

describe("handleBackgroundToolStarted", () => {
  it("inserts a running entry with started metadata", () => {
    start();
    const entry = getState().byId["bg-1"];
    expect(entry).toBeDefined();
    expect(entry?.status).toBe("running");
    expect(entry?.toolName).toBe("bash");
    expect(entry?.conversationId).toBe("conv-1");
    expect(entry?.command).toBe("sleep 5");
    expect(entry?.startedAt).toBe(1000);
    expect(getState().orderedIds).toEqual(["bg-1"]);
  });
});

describe("handleBackgroundToolCompleted", () => {
  it("settles a started task to a terminal entry", () => {
    start();
    handleBackgroundToolCompleted({
      type: "background_tool_completed",
      id: "bg-1",
      conversationId: "conv-1",
      status: "completed",
      exitCode: 0,
      output: "done",
      completedAt: 2000,
    });
    const entry = getState().byId["bg-1"];
    expect(entry?.status).toBe("completed");
    expect(entry?.exitCode).toBe(0);
    expect(entry?.output).toBe("done");
    expect(entry?.completedAt).toBe(2000);
  });

  it("ignores a completion for an unknown task", () => {
    handleBackgroundToolCompleted({
      type: "background_tool_completed",
      id: "bg-missing",
      conversationId: "conv-1",
      status: "completed",
      completedAt: 2000,
    });
    expect(getState().byId).toEqual({});
  });
});

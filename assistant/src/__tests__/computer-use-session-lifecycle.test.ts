import { describe, expect, mock, test } from "bun:test";

// Mock config before importing modules that depend on it.
// The permissions mode must be 'workspace' so computer-use tools
// go through normal workspace trust evaluation instead of prompting.
mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},

    provider: "mock-provider",
    permissions: { mode: "workspace" },
    apiKeys: {},
    sandbox: { enabled: false },
    timeouts: { toolExecutionTimeoutSec: 30, permissionTimeoutSec: 5 },
    skills: { load: { extraDirs: [] } },
    secretDetection: { enabled: false },
    contextWindow: {
      enabled: true,
      maxInputTokens: 180000,
      targetBudgetRatio: 0.30,
      compactThreshold: 0.8,      summaryBudgetRatio: 0.05,
    },
  }),
  invalidateConfigCache: () => {},
}));

import { ComputerUseSession } from "../daemon/computer-use-session.js";
import type {
  CuObservation,
  ServerMessage,
} from "../daemon/message-protocol.js";
import type { Provider, ProviderResponse } from "../providers/types.js";

function createProvider(responses: ProviderResponse[]): {
  provider: Provider;
  getCalls: () => number;
} {
  let calls = 0;
  const provider: Provider = {
    name: "mock",
    async sendMessage() {
      const response = responses[calls] ?? responses[responses.length - 1];
      calls++;
      return response;
    },
  };
  return { provider, getCalls: () => calls };
}

describe("ComputerUseSession lifecycle", () => {
  test("stops provider loop immediately after terminal computer_use_done tool", async () => {
    const { provider, getCalls } = createProvider([
      {
        content: [
          {
            type: "tool_use",
            id: "tu-1",
            name: "computer_use_done",
            input: { summary: "Task finished" },
          },
        ],
        model: "mock-model",
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "tool_use",
      },
      {
        content: [{ type: "text", text: "This should never be requested" }],
        model: "mock-model",
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "end_turn",
      },
    ]);

    const sentMessages: ServerMessage[] = [];
    let terminalCalls = 0;

    const session = new ComputerUseSession(
      "cu-test-1",
      "test task",
      1440,
      900,
      provider,
      (msg) => {
        sentMessages.push(msg);
      },
      "computer_use",
      () => {
        terminalCalls++;
      },
    );

    const observation: CuObservation = {
      type: "cu_observation",
      sessionId: "cu-test-1",
      axTree: 'Window "Test" [1]',
    };

    await session.handleObservation(observation);

    // If computer_use_done does not abort the loop, we'd see an extra provider call.
    expect(getCalls()).toBe(1);
    expect(session.getState()).toBe("complete");
    expect(terminalCalls).toBe(1);

    const completes = sentMessages.filter(
      (msg): msg is Extract<ServerMessage, { type: "cu_complete" }> =>
        msg.type === "cu_complete",
    );
    expect(completes).toHaveLength(1);
    expect(completes[0].summary).toBe("Task finished");
  });

  test("notifies terminal callback only once on repeated abort calls", () => {
    const { provider } = createProvider([
      {
        content: [{ type: "text", text: "unused" }],
        model: "mock-model",
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      },
    ]);

    let terminalCalls = 0;
    const session = new ComputerUseSession(
      "cu-test-2",
      "test task",
      1440,
      900,
      provider,
      () => {},
      "computer_use",
      () => {
        terminalCalls++;
      },
    );

    session.abort();
    session.abort();

    expect(terminalCalls).toBe(1);
    expect(session.getState()).toBe("error");
  });

  test("CU session passes exactly 12 computer_use_* tools to the agent loop", async () => {
    let capturedTools: string[] = [];
    const provider: Provider = {
      name: "mock",
      async sendMessage(_msgs, tools) {
        capturedTools = (tools ?? []).map((t) => t.name);
        return {
          content: [
            {
              type: "tool_use",
              id: "tu-capture",
              name: "computer_use_done",
              input: { summary: "Done" },
            },
          ],
          model: "mock-model",
          usage: { inputTokens: 10, outputTokens: 5 },
          stopReason: "tool_use",
        };
      },
    };

    const session = new ComputerUseSession(
      "cu-tool-capture",
      "capture tools",
      1440,
      900,
      provider,
      () => {},
      "computer_use",
    );

    await session.handleObservation({
      type: "cu_observation",
      sessionId: "cu-tool-capture",
      axTree: 'Window "Test" [1]',
    });

    const cuTools = capturedTools.filter((n) => n.startsWith("computer_use_"));
    expect(cuTools).toHaveLength(12);

    // Assert exact set of expected CU tool names
    const expectedCuTools = [
      "computer_use_click",
      "computer_use_double_click",
      "computer_use_right_click",
      "computer_use_type_text",
      "computer_use_key",
      "computer_use_scroll",
      "computer_use_drag",
      "computer_use_wait",
      "computer_use_open_app",
      "computer_use_run_applescript",
      "computer_use_done",
      "computer_use_respond",
    ];
    for (const name of expectedCuTools) {
      expect(cuTools).toContain(name);
    }
  });

  test("computer_use_respond is a terminal tool that completes the session", async () => {
    const { provider } = createProvider([
      {
        content: [
          {
            type: "tool_use",
            id: "tu-respond",
            name: "computer_use_respond",
            input: {
              answer: "The meeting is at 3pm",
              reasoning: "Found in calendar",
            },
          },
        ],
        model: "mock-model",
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "tool_use",
      },
    ]);

    const sentMessages: ServerMessage[] = [];
    const session = new ComputerUseSession(
      "cu-respond-test",
      "check my schedule",
      1440,
      900,
      provider,
      (msg) => {
        sentMessages.push(msg);
      },
      "computer_use",
    );

    await session.handleObservation({
      type: "cu_observation",
      sessionId: "cu-respond-test",
      axTree: 'Window "Calendar" [1]',
    });

    expect(session.getState()).toBe("complete");
    const completes = sentMessages.filter(
      (msg): msg is Extract<ServerMessage, { type: "cu_complete" }> =>
        msg.type === "cu_complete",
    );
    expect(completes).toHaveLength(1);
    expect(completes[0].summary).toBe("The meeting is at 3pm");
    expect(completes[0].isResponse).toBe(true);
  });

  test("default construction preactivates computer-use skill and provides 12 CU tools", async () => {
    let capturedTools: string[] = [];
    const provider: Provider = {
      name: "mock",
      async sendMessage(_msgs, tools) {
        capturedTools = (tools ?? []).map((t) => t.name);
        return {
          content: [
            {
              type: "tool_use",
              id: "tu-default",
              name: "computer_use_done",
              input: { summary: "Done" },
            },
          ],
          model: "mock-model",
          usage: { inputTokens: 10, outputTokens: 5 },
          stopReason: "tool_use",
        };
      },
    };

    // No preactivatedSkillIds passed — defaults to ['computer-use'] via skill projection
    const session = new ComputerUseSession(
      "cu-default-projection",
      "test default projection",
      1440,
      900,
      provider,
      () => {},
      "computer_use",
      undefined,
    );

    await session.handleObservation({
      type: "cu_observation",
      sessionId: "cu-default-projection",
      axTree: 'Window "Test" [1]',
    });

    const cuTools = capturedTools.filter((n) => n.startsWith("computer_use_"));
    expect(cuTools).toHaveLength(12);
  });

  test("constructor accepts preactivatedSkillIds parameter", () => {
    const { provider } = createProvider([
      {
        content: [{ type: "text", text: "unused" }],
        model: "mock-model",
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      },
    ]);

    // Should not throw
    const session = new ComputerUseSession(
      "cu-preactivated",
      "test preactivated",
      1440,
      900,
      provider,
      () => {},
      "computer_use",
      undefined,
      ["computer-use"],
    );

    expect(session).toBeDefined();
  });
});

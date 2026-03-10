import { beforeAll, describe, expect, mock, test } from "bun:test";

// Mock config before importing modules that depend on it.
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
      targetInputTokens: 110000,
      compactThreshold: 0.8,
      preserveRecentUserTurns: 8,
      summaryBudgetRatio: 0.05,
    },
  }),
  invalidateConfigCache: () => {},
}));

import { ComputerUseSession } from "../daemon/computer-use-session.js";
import type { CuObservation } from "../daemon/message-protocol.js";
import type { Provider, ProviderResponse } from "../providers/types.js";
import {
  __resetRegistryForTesting,
  getAllTools,
  getSkillRefCount,
  initializeTools,
} from "../tools/registry.js";

function createProvider(responses: ProviderResponse[]): Provider {
  let calls = 0;
  return {
    name: "mock",
    async sendMessage() {
      const response = responses[calls] ?? responses[responses.length - 1];
      calls++;
      return response;
    },
  };
}

const doneResponse: ProviderResponse = {
  content: [
    {
      type: "tool_use",
      id: "tu-cleanup",
      name: "computer_use_done",
      input: { summary: "Done" },
    },
  ],
  model: "mock-model",
  usage: { inputTokens: 10, outputTokens: 5 },
  stopReason: "tool_use",
};

const observation: CuObservation = {
  type: "cu_observation",
  sessionId: "cleanup-test",
  axTree: 'Window "Test" [1]',
};

describe("CU session skill tool lifecycle cleanup", () => {
  beforeAll(async () => {
    __resetRegistryForTesting();
    await initializeTools();
  });

  test("computer-use skill refcount is 0 after session completes via computer_use_done", async () => {
    const provider = createProvider([doneResponse]);
    const session = new ComputerUseSession(
      "cleanup-done",
      "test cleanup",
      1440,
      900,
      provider,
      () => {},
      "computer_use",
    );

    expect(getSkillRefCount("computer-use")).toBe(0);

    await session.handleObservation({
      ...observation,
      sessionId: "cleanup-done",
    });

    expect(session.getState()).toBe("complete");
    expect(getSkillRefCount("computer-use")).toBe(0);
  });

  test("computer-use skill refcount is 0 after session is aborted", async () => {
    // Use a provider that hangs until the abort signal fires, keeping the
    // session active long enough to abort after skill projection has occurred.
    const hangingProvider: Provider = {
      name: "mock",
      sendMessage: (_msgs, _tools, _sys, opts) =>
        new Promise<ProviderResponse>((_, reject) => {
          if (opts?.signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
          }
          opts?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    };

    const session = new ComputerUseSession(
      "cleanup-abort",
      "test abort cleanup",
      1440,
      900,
      hangingProvider,
      () => {},
      "computer_use",
    );

    expect(getSkillRefCount("computer-use")).toBe(0);

    // Start the session (don't await — it will hang on the provider call).
    // Skill projection happens synchronously at the start of runAgentLoop,
    // so by the time sendMessage is called the refcount has been incremented.
    const sessionPromise = session.handleObservation({
      ...observation,
      sessionId: "cleanup-abort",
    });

    // Yield to let runAgentLoop start and reach the provider call
    await new Promise((r) => setTimeout(r, 50));

    session.abort();

    // Let the session finish its cleanup
    await sessionPromise;

    expect(session.getState()).toBe("error");
    expect(getSkillRefCount("computer-use")).toBe(0);
  });

  test("computer-use skill refcount is 0 after session completes via computer_use_respond", async () => {
    const provider = createProvider([
      {
        content: [
          {
            type: "tool_use",
            id: "tu-respond-cleanup",
            name: "computer_use_respond",
            input: { answer: "Test answer", reasoning: "Test reasoning" },
          },
        ],
        model: "mock-model",
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "tool_use",
      },
    ]);

    const session = new ComputerUseSession(
      "cleanup-respond",
      "test respond cleanup",
      1440,
      900,
      provider,
      () => {},
      "computer_use",
    );

    await session.handleObservation({
      ...observation,
      sessionId: "cleanup-respond",
    });

    expect(session.getState()).toBe("complete");
    expect(getSkillRefCount("computer-use")).toBe(0);
  });

  test("only escalation tool remains in registry after session cleanup", async () => {
    const provider = createProvider([doneResponse]);
    const session = new ComputerUseSession(
      "cleanup-registry-check",
      "test registry cleanup",
      1440,
      900,
      provider,
      () => {},
      "computer_use",
    );

    await session.handleObservation({
      ...observation,
      sessionId: "cleanup-registry-check",
    });

    expect(session.getState()).toBe("complete");

    const allTools = getAllTools();
    const cuTools = allTools.filter((t) => t.name.startsWith("computer_use_"));
    expect(cuTools).toHaveLength(1);
    expect(cuTools[0].name).toBe("computer_use_request_control");
  });

  test("multiple sequential CU sessions do not leak refcounts", async () => {
    for (let i = 0; i < 3; i++) {
      const provider = createProvider([doneResponse]);
      const session = new ComputerUseSession(
        `cleanup-sequential-${i}`,
        "test sequential cleanup",
        1440,
        900,
        provider,
        () => {},
        "computer_use",
      );

      await session.handleObservation({
        ...observation,
        sessionId: `cleanup-sequential-${i}`,
      });
      expect(session.getState()).toBe("complete");
    }

    expect(getSkillRefCount("computer-use")).toBe(0);

    const allTools = getAllTools();
    const cuTools = allTools.filter((t) => t.name.startsWith("computer_use_"));
    expect(cuTools).toHaveLength(1);
    expect(cuTools[0].name).toBe("computer_use_request_control");
  });

  // Cross-suite regression: after CU sessions complete, core registry invariants hold
  test("core registry has 1 computer_use_* tool after CU session lifecycle (escalation only)", () => {
    const allTools = getAllTools();
    const cuTools = allTools.filter((t) => t.name.startsWith("computer_use_"));
    expect(cuTools).toHaveLength(1);
    expect(cuTools[0].name).toBe("computer_use_request_control");
  });

  test("computer_use_request_control is in core registry after CU session lifecycle", async () => {
    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("computer_use_request_control");
    expect(tool).toBeDefined();
  });
});

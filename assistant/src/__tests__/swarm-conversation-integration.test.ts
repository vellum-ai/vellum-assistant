import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — declared before imports that depend on them
// ---------------------------------------------------------------------------

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../hooks/manager.js", () => ({
  getHookManager: () => ({
    trigger: async () => ({ blocked: false }),
  }),
}));

let swarmEnabled = true;

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},

    provider: "anthropic",
    providerOrder: ["anthropic"],
    swarm: {
      enabled: swarmEnabled,
      maxWorkers: 2,
      maxTasks: 4,
      maxRetriesPerTask: 1,
      workerTimeoutSec: 900,
      roleTimeoutsSec: {},
      plannerModelIntent: "latency-optimized",
      synthesizerModelIntent: "quality-optimized",
    },
    services: {
      inference: {
        mode: "your-own",
        provider: "anthropic",
        model: "claude-opus-4-6",
      },
      "image-generation": {
        mode: "your-own",
        provider: "gemini",
        model: "gemini-3.1-flash-image-preview",
      },
      "web-search": { mode: "your-own", provider: "anthropic-native" },
    },
  }),
}));

const mockTestProvider = {
  name: "test",
  async sendMessage() {
    return {
      content: [
        {
          type: "text",
          text: '{"tasks":[{"id":"t1","role":"coder","objective":"Do it","dependencies":[]}]}',
        },
      ],
      model: "test",
      usage: { inputTokens: 10, outputTokens: 10 },
      stopReason: "end_turn",
    };
  },
};
let mockAnthropicKey: string | undefined = "test-api-key";
mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: async () => mockAnthropicKey,
}));

mock.module("../providers/registry.js", () => ({
  getProvider: () => mockTestProvider,
  getFailoverProvider: () => mockTestProvider,
}));

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: () => ({
    async *[Symbol.asyncIterator]() {
      yield {
        type: "result" as const,
        session_id: "test-session",
        subtype: "success" as const,
        result:
          '```json\n{"summary":"Done","artifacts":[],"issues":[],"nextSteps":[]}\n```',
      };
    },
  }),
}));

import type { AgentEvent } from "../agent/loop.js";
import { AgentLoop } from "../agent/loop.js";
import type { Message, ProviderResponse } from "../providers/types.js";
import {
  _resetSwarmActive,
  swarmDelegateTool,
} from "../tools/swarm/delegate.js";
import type { ToolContext } from "../tools/types.js";

function makeContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    conversationId: "test-conv",
    workingDir: "/tmp/test",
    trustClass: "guardian",
    onOutput: () => {},
    ...overrides,
  } as ToolContext;
}

// ---------------------------------------------------------------------------
// 1. Agent loop + swarm_delegate integration
// ---------------------------------------------------------------------------

describe("swarm through AgentLoop", () => {
  beforeEach(() => {
    _resetSwarmActive();
    swarmEnabled = true;
  });

  test("agent loop calls swarm_delegate and receives tool result", async () => {
    let turnCount = 0;

    // Provider that emits swarm_delegate tool_use on turn 1, then text on turn 2
    const mockProvider = {
      name: "test",
      async sendMessage(_messages: Message[]) {
        turnCount++;
        if (turnCount === 1) {
          return {
            content: [
              {
                type: "tool_use" as const,
                id: "tu-1",
                name: "swarm_delegate",
                input: { objective: "Build a feature with tests" },
              },
            ],
            model: "test",
            usage: { inputTokens: 10, outputTokens: 10 },
            stopReason: "tool_use",
          } as ProviderResponse;
        }
        return {
          content: [{ type: "text" as const, text: "All done." }],
          model: "test",
          usage: { inputTokens: 10, outputTokens: 10 },
          stopReason: "end_turn",
        } as ProviderResponse;
      },
    };

    const events: AgentEvent[] = [];
    const toolExecutor = async (
      _name: string,
      input: Record<string, unknown>,
      onOutput?: (chunk: string) => void,
    ) => {
      const result = await swarmDelegateTool.execute(
        input,
        makeContext({ onOutput }),
      );
      return result;
    };

    const tools = [swarmDelegateTool.getDefinition()];

    const loop = new AgentLoop(
      mockProvider,
      "system prompt",
      {},
      tools,
      toolExecutor,
    );
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Build a feature" }] },
    ];

    const history = await loop.run(messages, (e) => {
      events.push(e);
    });

    // Should have tool_use event
    const toolUseEvents = events.filter((e) => e.type === "tool_use");
    expect(toolUseEvents.length).toBe(1);
    expect(toolUseEvents[0].type === "tool_use" && toolUseEvents[0].name).toBe(
      "swarm_delegate",
    );

    // Should have tool_result event
    const toolResultEvents = events.filter((e) => e.type === "tool_result");
    expect(toolResultEvents.length).toBe(1);
    expect(
      toolResultEvents[0].type === "tool_result" &&
        !toolResultEvents[0].isError,
    ).toBe(true);

    // Should have progress output chunks
    const chunks = events.filter((e) => e.type === "tool_output_chunk");
    expect(chunks.length).toBeGreaterThan(0);

    // History should contain assistant + tool_result + final assistant
    expect(history.length).toBeGreaterThanOrEqual(4);
  });

  test("agent loop handles aborted swarm gracefully", async () => {
    const controller = new AbortController();

    const mockProvider = {
      name: "test",
      async sendMessage() {
        // Abort after model responds with tool_use
        controller.abort();
        return {
          content: [
            {
              type: "tool_use" as const,
              id: "tu-abort",
              name: "swarm_delegate",
              input: { objective: "Should be cancelled" },
            },
          ],
          model: "test",
          usage: { inputTokens: 10, outputTokens: 10 },
          stopReason: "tool_use",
        } as ProviderResponse;
      },
    };

    const events: AgentEvent[] = [];
    const toolExecutor = async (
      _name: string,
      input: Record<string, unknown>,
      onOutput?: (chunk: string) => void,
    ) => {
      return swarmDelegateTool.execute(
        input,
        makeContext({ onOutput, signal: controller.signal }),
      );
    };

    const tools = [swarmDelegateTool.getDefinition()];
    const loop = new AgentLoop(mockProvider, "system", {}, tools, toolExecutor);
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "go" }] },
    ];

    // Should not hang or throw
    const history = await loop.run(
      messages,
      (e) => {
        events.push(e);
      },
      controller.signal,
    );
    expect(history.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Regression tests for swarm-specific behaviors
// ---------------------------------------------------------------------------

describe("swarm regression tests", () => {
  beforeEach(() => {
    _resetSwarmActive();
    swarmEnabled = true;
  });

  test("swarm_delegate returns graceful message when disabled", async () => {
    swarmEnabled = false;
    const result = await swarmDelegateTool.execute(
      { objective: "Some task" },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("disabled");
    swarmEnabled = true;
  });

  test("recursion guard blocks concurrent invocation", async () => {
    const ctx = makeContext();

    // Start first swarm without awaiting — execute runs synchronously up to
    // its first internal `await`, which adds the sessionKey to activeSessions
    // before yielding back to us.
    const first = swarmDelegateTool.execute({ objective: "First" }, ctx);

    // While the first call is still in-flight, a second call on the same
    // session should be rejected by the recursion guard.
    const result2 = await swarmDelegateTool.execute(
      { objective: "Second" },
      ctx,
    );
    expect(result2.isError).toBe(true);
    expect(result2.content).toContain("already executing");

    // Let the first call finish and verify it succeeded
    const result1 = await first;
    expect(result1.isError).toBeFalsy();

    // After the first call completes, the guard should be released —
    // a subsequent call must succeed.
    const result3 = await swarmDelegateTool.execute(
      { objective: "Third" },
      ctx,
    );
    expect(result3.isError).toBeFalsy();
  });

  test("worker backend reports unavailable when no API key", async () => {
    const prevKey = mockAnthropicKey;
    const prevEnv = process.env.ANTHROPIC_API_KEY;
    mockAnthropicKey = undefined;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const result = await swarmDelegateTool.execute(
        { objective: "Task without key" },
        makeContext(),
      );

      // The tool should still complete — the orchestrator handles backend failures
      // Tasks should fail because no backend is available
      expect(result.content).toBeTruthy();
      expect(result.content).toContain("failed");
    } finally {
      mockAnthropicKey = prevKey;
      if (prevEnv !== undefined) {
        process.env.ANTHROPIC_API_KEY = prevEnv;
      }
    }
  });

  test("progress chunks stream through onOutput", async () => {
    const outputs: string[] = [];
    await swarmDelegateTool.execute(
      { objective: "Track progress" },
      makeContext({ onOutput: (text: string) => outputs.push(text) }),
    );

    // Should have planning and execution output
    expect(outputs.some((o) => o.includes("Planning"))).toBe(true);
    expect(outputs.some((o) => o.includes("Plan:"))).toBe(true);
    expect(outputs.some((o) => o.includes("Executing"))).toBe(true);
  });

  test("result includes task stats", async () => {
    const result = await swarmDelegateTool.execute(
      { objective: "Check stats" },
      makeContext(),
    );
    expect(result.content).toContain("Tasks:");
    expect(result.content).toContain("Duration:");
  });
});

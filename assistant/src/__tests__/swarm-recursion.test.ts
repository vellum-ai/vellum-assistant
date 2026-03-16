import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Gate that the SDK mock waits on, letting us hold a swarm active while
// attempting a second invocation.
// ---------------------------------------------------------------------------

let gate: { promise: Promise<void>; resolve: () => void } | null = null;

function openGate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  gate = { promise, resolve };
}

function closeGate() {
  gate?.resolve();
  gate = null;
}

// ---------------------------------------------------------------------------
// Mocks — declared before imports
// ---------------------------------------------------------------------------

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},

    provider: "anthropic",
    providerOrder: ["anthropic"],
    swarm: {
      enabled: true,
      maxWorkers: 3,
      maxTasks: 8,
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
        model: "gemini-2.5-flash-image",
      },
      "web-search": { mode: "your-own", provider: "anthropic-native" },
    },
  }),
}));

const mockProvider = {
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
mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: async () => "test-api-key",
}));

mock.module("../providers/registry.js", () => ({
  getProvider: () => mockProvider,
  getFailoverProvider: () => mockProvider,
}));

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: () => ({
    async *[Symbol.asyncIterator]() {
      // If a gate is open, wait on it — this holds the swarm active
      if (gate) await gate.promise;
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

describe("swarm recursion guard (concurrent)", () => {
  beforeEach(() => {
    _resetSwarmActive();
    closeGate();
  });

  test("rejects second invocation on same session while first is still active", async () => {
    openGate();

    // Start first swarm — it will pause at the SDK mock
    const first = swarmDelegateTool.execute(
      { objective: "First task" },
      makeContext({ conversationId: "session-A" }),
    );

    // Yield to let first reach the SDK gate (executeSwarm path)
    await new Promise((r) => setTimeout(r, 50));

    // Second invocation on the same session should be rejected
    const second = await swarmDelegateTool.execute(
      { objective: "Second task" },
      makeContext({ conversationId: "session-A" }),
    );
    expect(second.isError).toBe(true);
    expect(second.content).toContain("already executing");

    // Release the gate so first completes
    closeGate();
    const firstResult = await first;
    expect(firstResult.isError).toBeFalsy();
  });

  test("allows concurrent swarms on different sessions", async () => {
    openGate();

    // Start first swarm on session A
    const first = swarmDelegateTool.execute(
      { objective: "Conversation A task" },
      makeContext({ conversationId: "session-A" }),
    );

    // Yield to let first reach the gate
    await new Promise((r) => setTimeout(r, 50));

    // Release the gate before starting session B so both can complete
    closeGate();

    // Second swarm on a different session should succeed
    const second = await swarmDelegateTool.execute(
      { objective: "Conversation B task" },
      makeContext({ conversationId: "session-B" }),
    );
    expect(second.isError).toBeFalsy();

    const firstResult = await first;
    expect(firstResult.isError).toBeFalsy();
  });

  test("guard is released after first swarm completes", async () => {
    // Run and complete first swarm (no gate)
    const first = await swarmDelegateTool.execute(
      { objective: "First task" },
      makeContext({ conversationId: "session-A" }),
    );
    expect(first.isError).toBeFalsy();

    // Same session should now be allowed again
    const second = await swarmDelegateTool.execute(
      { objective: "Second task" },
      makeContext({ conversationId: "session-A" }),
    );
    expect(second.isError).toBeFalsy();
  });
});

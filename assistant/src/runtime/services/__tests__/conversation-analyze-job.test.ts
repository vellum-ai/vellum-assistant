/**
 * Unit tests for the `conversation_analyze` job handler.
 *
 * The handler bridges the jobs worker to `analyzeConversation()`. Tests stub
 * the service so we exercise dispatch logic without pulling in full daemon
 * wiring.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

mock.module("../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Mock analyze-conversation service — default resolves with a success result.
type AnalyzeArgs = {
  conversationId: string;
  opts: { trigger: "manual" | "auto" };
};
const analyzeCalls: AnalyzeArgs[] = [];
type AnalyzeResultStub =
  | { analysisConversationId: string; skipped?: true }
  | { error: { kind: string; status: number; message: string } };
const mockAnalyzeConversation = mock(
  async (
    conversationId: string,
    opts: { trigger: "manual" | "auto" },
  ): Promise<AnalyzeResultStub> => {
    analyzeCalls.push({ conversationId, opts });
    return { analysisConversationId: "analysis-1" };
  },
);

// Mock auto-analysis-enqueue — track calls so we can verify requeue behavior.
type EnqueueArgs = {
  conversationId: string;
  trigger: string;
};
const enqueueCalls: EnqueueArgs[] = [];
const mockEnqueueAutoAnalysisIfEnabled = mock((args: EnqueueArgs) => {
  enqueueCalls.push(args);
});

// Scope the sibling-module stubs to this suite's lifecycle. Bun's `mock.module`
// is process-global and is NOT undone by `mock.restore()`, so registering these
// at the top level leaks the stubs into sibling suites that import the real
// modules in the same Bun process (analyze-conversation.test.ts,
// auto-analysis-enqueue.test.ts). Register the stubs in `beforeAll` and
// re-register the real modules in `afterAll`.
//
// The captures spread into a plain object (`{ ...(await import()) }`) to freeze
// the real exports by value. A module-namespace reference is a live view:
// `mock.module` mutates it in place, so a bare `await import` would itself
// return the stub once the stub is registered, and `afterAll` would "restore"
// the stub instead of the real module.
const actualAnalyzeConversation = {
  ...(await import("../analyze-conversation.js")),
};
const actualAutoAnalysisEnqueue = {
  ...(await import("../auto-analysis-enqueue.js")),
};

beforeAll(() => {
  mock.module("../analyze-conversation.js", () => ({
    ...actualAnalyzeConversation,
    analyzeConversation: mockAnalyzeConversation,
  }));
  mock.module("../auto-analysis-enqueue.js", () => ({
    ...actualAutoAnalysisEnqueue,
    enqueueAutoAnalysisIfEnabled: mockEnqueueAutoAnalysisIfEnabled,
  }));
});

afterAll(() => {
  mock.module("../analyze-conversation.js", () => actualAnalyzeConversation);
  mock.module("../auto-analysis-enqueue.js", () => actualAutoAnalysisEnqueue);
});

import { DEFAULT_CONFIG } from "../../../config/defaults.js";
import type { AssistantConfig } from "../../../config/types.js";
import type { MemoryJob } from "../../../persistence/jobs-store.js";
import { conversationAnalyzeJob } from "../conversation-analyze-job.js";

const TEST_CONFIG: AssistantConfig = DEFAULT_CONFIG;

function makeJob(payload: Record<string, unknown>): MemoryJob<{
  conversationId?: string;
}> {
  return {
    id: "job-1",
    type: "conversation_analyze",
    payload: payload as { conversationId?: string },
    status: "running",
    attempts: 0,
    deferrals: 0,
    runAfter: 0,
    lastError: null,
    startedAt: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe("conversationAnalyzeJob", () => {
  beforeEach(() => {
    analyzeCalls.length = 0;
    enqueueCalls.length = 0;
    mockAnalyzeConversation.mockReset();
    mockAnalyzeConversation.mockImplementation(
      async (conversationId: string, opts: { trigger: "manual" | "auto" }) => {
        analyzeCalls.push({ conversationId, opts });
        return { analysisConversationId: "analysis-1" };
      },
    );
  });

  test("returns without calling the service when conversationId is missing", async () => {
    await conversationAnalyzeJob(makeJob({}), TEST_CONFIG);
    expect(analyzeCalls).toHaveLength(0);
  });

  test("returns without calling the service when conversationId is empty string", async () => {
    await conversationAnalyzeJob(makeJob({ conversationId: "" }), TEST_CONFIG);
    expect(analyzeCalls).toHaveLength(0);
  });

  test("invokes analyzeConversation with trigger=auto and the conversationId", async () => {
    await conversationAnalyzeJob(
      makeJob({ conversationId: "conv-42" }),
      TEST_CONFIG,
    );

    expect(analyzeCalls).toHaveLength(1);
    expect(analyzeCalls[0]!.conversationId).toBe("conv-42");
    expect(analyzeCalls[0]!.opts).toEqual({ trigger: "auto" });
  });

  test("requeues a follow-up idle trigger when the service returns skipped=true", async () => {
    mockAnalyzeConversation.mockImplementation(async () => ({
      analysisConversationId: "analysis-1",
      skipped: true as const,
    }));

    await conversationAnalyzeJob(
      makeJob({ conversationId: "conv-busy" }),
      TEST_CONFIG,
    );

    expect(enqueueCalls).toHaveLength(1);
    expect(enqueueCalls[0]).toEqual({
      conversationId: "conv-busy",
      trigger: "idle",
    });
  });

  test("does not requeue on a normal (non-skipped) successful run", async () => {
    mockAnalyzeConversation.mockImplementation(async () => ({
      analysisConversationId: "analysis-1",
    }));

    await conversationAnalyzeJob(
      makeJob({ conversationId: "conv-ok" }),
      TEST_CONFIG,
    );

    expect(enqueueCalls).toHaveLength(0);
  });

  test("does not requeue when the service returns an error result", async () => {
    mockAnalyzeConversation.mockImplementation(async () => ({
      error: {
        kind: "BAD_REQUEST",
        status: 400,
        message: "Cannot auto-analyze an auto-analysis conversation",
      },
    }));

    await conversationAnalyzeJob(
      makeJob({ conversationId: "conv-err" }),
      TEST_CONFIG,
    );

    expect(enqueueCalls).toHaveLength(0);
  });

  test("swallows (does not throw) when the service returns an error result", async () => {
    mockAnalyzeConversation.mockImplementation(async () => ({
      error: {
        kind: "BAD_REQUEST",
        status: 400,
        message: "Cannot auto-analyze an auto-analysis conversation",
      },
    }));

    await expect(
      conversationAnalyzeJob(
        makeJob({ conversationId: "conv-2" }),
        TEST_CONFIG,
      ),
    ).resolves.toBeUndefined();
  });
});

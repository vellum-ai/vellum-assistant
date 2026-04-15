/**
 * Unit tests for the `conversation_analyze` job handler.
 *
 * The handler bridges the jobs worker to `analyzeConversation()` via the
 * singleton deps bundle. Tests stub both the singleton and the service so we
 * exercise dispatch logic without pulling in HTTP-layer wiring.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Mock analyze-deps singleton — each test overrides via mockGetAnalysisDeps.
type DepsStub = Record<string, unknown>;
const mockGetAnalysisDeps = mock((): DepsStub | null => null);

mock.module("../../runtime/services/analyze-deps-singleton.js", () => ({
  getAnalysisDeps: mockGetAnalysisDeps,
}));

// Mock analyze-conversation service — default resolves with a success result.
type AnalyzeArgs = {
  conversationId: string;
  deps: DepsStub;
  opts: { trigger: "manual" | "auto" };
};
const analyzeCalls: AnalyzeArgs[] = [];
type AnalyzeResultStub =
  | { analysisConversationId: string }
  | { error: { kind: string; status: number; message: string } };
const mockAnalyzeConversation = mock(
  async (
    conversationId: string,
    deps: DepsStub,
    opts: { trigger: "manual" | "auto" },
  ): Promise<AnalyzeResultStub> => {
    analyzeCalls.push({ conversationId, deps, opts });
    return { analysisConversationId: "analysis-1" };
  },
);

mock.module("../../runtime/services/analyze-conversation.js", () => ({
  analyzeConversation: mockAnalyzeConversation,
}));

import { DEFAULT_CONFIG } from "../../config/defaults.js";
import type { AssistantConfig } from "../../config/types.js";
import { conversationAnalyzeJob } from "../conversation-analyze-job.js";
import type { MemoryJob } from "../jobs-store.js";

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
    mockGetAnalysisDeps.mockReset();
    mockGetAnalysisDeps.mockImplementation(() => null);
    mockAnalyzeConversation.mockReset();
    mockAnalyzeConversation.mockImplementation(
      async (
        conversationId: string,
        deps: DepsStub,
        opts: { trigger: "manual" | "auto" },
      ) => {
        analyzeCalls.push({ conversationId, deps, opts });
        return { analysisConversationId: "analysis-1" };
      },
    );
  });

  test("returns without calling the service when conversationId is missing", async () => {
    await conversationAnalyzeJob(makeJob({}), TEST_CONFIG);
    expect(analyzeCalls).toHaveLength(0);
    expect(mockGetAnalysisDeps).not.toHaveBeenCalled();
  });

  test("returns without calling the service when conversationId is empty string", async () => {
    await conversationAnalyzeJob(
      makeJob({ conversationId: "" }),
      TEST_CONFIG,
    );
    expect(analyzeCalls).toHaveLength(0);
    expect(mockGetAnalysisDeps).not.toHaveBeenCalled();
  });

  test("throws when deps singleton is not yet initialized (worker reschedules)", async () => {
    mockGetAnalysisDeps.mockImplementation(() => null);
    await expect(
      conversationAnalyzeJob(
        makeJob({ conversationId: "conv-1" }),
        TEST_CONFIG,
      ),
    ).rejects.toThrow(/not yet initialized/i);
    expect(analyzeCalls).toHaveLength(0);
  });

  test("invokes analyzeConversation with trigger=auto and the conversationId", async () => {
    const depsStub: DepsStub = { _tag: "deps-stub" };
    mockGetAnalysisDeps.mockImplementation(() => depsStub);

    await conversationAnalyzeJob(
      makeJob({ conversationId: "conv-42" }),
      TEST_CONFIG,
    );

    expect(analyzeCalls).toHaveLength(1);
    expect(analyzeCalls[0]!.conversationId).toBe("conv-42");
    expect(analyzeCalls[0]!.opts).toEqual({ trigger: "auto" });
    expect(analyzeCalls[0]!.deps).toBe(depsStub);
  });

  test("swallows (does not throw) when the service returns an error result", async () => {
    mockGetAnalysisDeps.mockImplementation(() => ({ _tag: "deps" }));
    mockAnalyzeConversation.mockImplementation(async () => ({
      error: {
        kind: "BAD_REQUEST",
        status: 400,
        message: "Cannot auto-analyze an auto-analysis conversation",
      },
    }));

    // Must not throw — the worker would otherwise retry forever on a
    // deterministic rejection (e.g. the recursion guard).
    await expect(
      conversationAnalyzeJob(
        makeJob({ conversationId: "conv-2" }),
        TEST_CONFIG,
      ),
    ).resolves.toBeUndefined();
  });
});

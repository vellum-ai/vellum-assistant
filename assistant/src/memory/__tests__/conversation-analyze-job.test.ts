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
  | { analysisConversationId: string; skipped?: true }
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

// Mock auto-analysis-enqueue — track calls so we can verify requeue behavior.
type EnqueueArgs = {
  conversationId: string;
  trigger: string;
};
const enqueueCalls: EnqueueArgs[] = [];
const mockEnqueueAutoAnalysisIfEnabled = mock((args: EnqueueArgs) => {
  enqueueCalls.push(args);
});

mock.module("../auto-analysis-enqueue.js", () => ({
  enqueueAutoAnalysisIfEnabled: mockEnqueueAutoAnalysisIfEnabled,
}));

import { DEFAULT_CONFIG } from "../../config/defaults.js";
import type { AssistantConfig } from "../../config/types.js";
import { BackendUnavailableError } from "../../util/errors.js";
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
    enqueueCalls.length = 0;
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
    await conversationAnalyzeJob(makeJob({ conversationId: "" }), TEST_CONFIG);
    expect(analyzeCalls).toHaveLength(0);
    expect(mockGetAnalysisDeps).not.toHaveBeenCalled();
  });

  test("throws BackendUnavailableError when deps singleton is not yet initialized", async () => {
    // Deps singleton is unset during slow daemon startup. The handler throws
    // BackendUnavailableError so handleJobError() in the worker defers the
    // job with exponential backoff (via deferMemoryJob) instead of completing
    // it. Returning success here would permanently drop the job via
    // completeMemoryJob — conversations with a pre-existing queued job
    // during startup and no subsequent activity would never be analyzed.
    mockGetAnalysisDeps.mockImplementation(() => null);
    await expect(
      conversationAnalyzeJob(
        makeJob({ conversationId: "conv-1" }),
        TEST_CONFIG,
      ),
    ).rejects.toBeInstanceOf(BackendUnavailableError);
    expect(analyzeCalls).toHaveLength(0);
    expect(mockGetAnalysisDeps).toHaveBeenCalled();
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

  test("requeues a follow-up idle trigger when the service returns skipped=true", async () => {
    // If the rolling analysis conversation is already processing, the
    // service returns { skipped: true } without running. The job handler
    // completes successfully (no retry), so we must enqueue a follow-up
    // ourselves — otherwise, if no later batch/idle/lifecycle trigger
    // arrives, new source messages would never be analyzed.
    mockGetAnalysisDeps.mockImplementation(() => ({ _tag: "deps" }));
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
    mockGetAnalysisDeps.mockImplementation(() => ({ _tag: "deps" }));
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
    mockGetAnalysisDeps.mockImplementation(() => ({ _tag: "deps" }));
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

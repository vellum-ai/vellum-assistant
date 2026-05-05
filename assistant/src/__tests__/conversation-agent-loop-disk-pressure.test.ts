import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type { AgentLoop } from "../agent/loop.js";
import type { AgentLoopConversationContext } from "../daemon/conversation-agent-loop.js";
import type { DiskPressureStatus } from "../daemon/disk-pressure-guard.js";
import type { ServerMessage } from "../daemon/message-protocol.js";

type Context = AgentLoopConversationContext;

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    llm: {
      default: {
        provider: "mock-provider",
        model: "mock-model",
        maxTokens: 4096,
        effort: "max" as const,
        speed: "standard" as const,
        temperature: null,
        thinking: { enabled: false, streamThinking: true },
        contextWindow: {
          enabled: true,
          maxInputTokens: 100000,
          targetBudgetRatio: 0.3,
          compactThreshold: 0.8,
          summaryBudgetRatio: 0.05,
          overflowRecovery: {
            enabled: true,
            safetyMarginRatio: 0.05,
            maxAttempts: 3,
            interactiveLatestTurnCompression: "summarize",
            nonInteractiveLatestTurnCompression: "truncate",
          },
        },
      },
      profiles: {},
      callSites: {},
      pricingOverrides: [],
    },
    workspaceGit: { turnCommitMaxWaitMs: 10 },
    conversations: { skipAutoRetitling: true },
  }),
}));

const lockedDiskPressureStatus: DiskPressureStatus = {
  enabled: true,
  state: "critical",
  locked: true,
  acknowledged: true,
  overrideActive: false,
  effectivelyLocked: true,
  lockId: "disk-pressure-test",
  usagePercent: 98,
  thresholdPercent: 95,
  path: "/workspace",
  lastCheckedAt: "2026-05-05T00:00:00.000Z",
  blockedCapabilities: ["agent-turns", "background-work", "remote-ingress"],
  error: null,
};
const disabledDiskPressureStatus: DiskPressureStatus = {
  enabled: false,
  state: "disabled",
  locked: false,
  acknowledged: false,
  overrideActive: false,
  effectivelyLocked: false,
  lockId: null,
  usagePercent: null,
  thresholdPercent: 95,
  path: null,
  lastCheckedAt: null,
  blockedCapabilities: [],
  error: null,
};
let diskPressureStatus = lockedDiskPressureStatus;

mock.module("../daemon/disk-pressure-guard.js", () => ({
  getDiskPressureStatus: () => diskPressureStatus,
}));

mock.module("../memory/conversation-crud.js", () => ({
  clearStrippedInjectionMetadataForConversation: () => {},
  getConversation: () => ({
    id: "conv-123",
    conversationType: "background",
    source: "memory",
  }),
  getLastUserTimestampBefore: () => 0,
  getMessageById: () => null,
  getConversationOriginChannel: () => null,
  getConversationOriginInterface: () => null,
  getConversationOverrideProfileFromRow: () => null,
  provenanceFromTrustContext: () => ({}),
  updateConversationContextWindow: () => {},
  updateConversationSlackContextWatermark: () => {},
}));

import { runAgentLoopImpl } from "../daemon/conversation-agent-loop.js";

function makeCtx(
  overrides: Partial<Context> = {},
): AgentLoopConversationContext {
  return {
    conversationId: "conv-123",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    processing: true,
    abortController: new AbortController(),
    currentRequestId: "req-123",
    agentLoop: {
      run: async () => {
        throw new Error("agent loop should not run");
      },
      getToolTokenBudget: () => 0,
      getResolvedTools: () => [],
      getActiveModel: () => undefined,
    } as unknown as AgentLoop,
    provider: { name: "mock-provider" } as Context["provider"],
    systemPrompt: "system",
    contextWindowManager: {
      updateConfig: () => {},
      shouldCompact: () => ({ needed: false, estimatedTokens: 0 }),
      maybeCompact: async () => ({ compacted: false }),
    } as unknown as Context["contextWindowManager"],
    contextCompactedMessageCount: 0,
    contextCompactedAt: null,
    memoryPolicy: { scopeId: "default", includeDefaultFallback: true },
    currentActiveSurfaceId: undefined,
    currentPage: undefined,
    surfaceState: new Map(),
    pendingSurfaceActions: new Map(),
    surfaceActionRequestIds: new Set<string>(),
    currentTurnSurfaces: [],
    workingDir: "/tmp",
    workspaceTopLevelContext: null,
    workspaceTopLevelDirty: false,
    channelCapabilities: undefined,
    commandIntent: undefined,
    trustContext: undefined,
    coreToolNames: new Set(),
    allowedToolNames: undefined,
    preactivatedSkillIds: undefined,
    skillProjectionState: new Map(),
    skillProjectionCache: new Map() as Context["skillProjectionCache"],
    traceEmitter: { emit: () => {} } as unknown as Context["traceEmitter"],
    profiler: {
      startRequest: () => {},
      emitSummary: () => {},
    } as unknown as Context["profiler"],
    usageStats: {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalEstimatedCost: 0,
      model: "",
    },
    turnCount: 0,
    lastAssistantAttachments: [],
    lastAttachmentWarnings: [],
    hasNoClient: false,
    prompter: {} as Context["prompter"],
    queue: {} as Context["queue"],
    refreshWorkspaceTopLevelContextIfNeeded: () => {},
    markWorkspaceTopLevelDirty: () => {},
    emitActivityState: () => {},
    getQueueDepth: () => 0,
    hasQueuedMessages: () => false,
    canHandoffAtCheckpoint: () => false,
    drainQueue: async () => {},
    getTurnInterfaceContext: () => null,
    getTurnChannelContext: () => null,
    graphMemory: {} as Context["graphMemory"],
    ...overrides,
  } as AgentLoopConversationContext;
}

describe("runAgentLoopImpl disk pressure gate", () => {
  beforeEach(() => {
    diskPressureStatus = lockedDiskPressureStatus;
  });

  afterAll(() => {
    diskPressureStatus = disabledDiskPressureStatus;
  });

  test("blocks background turns inside the cleanup-safe finally path", async () => {
    const events: ServerMessage[] = [];
    const activityStates: unknown[][] = [];
    const drainQueue = mock(async (_reason: unknown) => {});
    const ctx = makeCtx({
      emitActivityState: (...args: unknown[]) => {
        activityStates.push(args);
      },
      drainQueue,
    });

    await runAgentLoopImpl(ctx, "background task", "msg-1", (event) =>
      events.push(event),
    );

    expect(events.find((event) => event.type === "error")).toMatchObject({
      conversationId: "conv-123",
      requestId: "req-123",
      code: "DISK_SPACE_CRITICAL",
      category: "disk_pressure",
    });
    expect(activityStates).toContainEqual([
      "idle",
      "error_terminal",
      "global",
      "req-123",
    ]);
    expect(ctx.processing).toBe(false);
    expect(ctx.abortController).toBeNull();
    expect(ctx.currentRequestId).toBeUndefined();
    expect(drainQueue).toHaveBeenCalledWith("loop_complete");
  });
});

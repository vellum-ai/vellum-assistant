/**
 * Regression test for ATL-1009: clear `processing_started_at` on fatal
 * agent-loop failure.
 *
 * The agent-loop `finally` block clears the conversation's processing flag
 * (`ctx.setProcessing(false)` → `processing_started_at = NULL`). That clear is
 * the release that unwedges the conversation. Several pre-clear steps run first
 * inside the same `finally` — most notably the turn-boundary commit. If one of
 * them throws (as the Bun `memoryUsage` crash in ATL-1007 did in the commit
 * path), execution must NOT skip the flag clear: otherwise the row stays
 * "mid-turn" forever, the next send times out with "did not respond in time",
 * and queued messages never drain.
 *
 * This test drives `runAgentLoopImpl` to a fatal failure (agent loop throws)
 * AND makes the turn-boundary commit throw inside the `finally`, then asserts
 * the processing flag was still cleared and the queue was still drained.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { CompactionCircuit } from "../agent/compaction-circuit.js";
import type { AgentLoop } from "../agent/loop.js";
import type { Conversation } from "../daemon/conversation.js";
import type { DiskPressureStatus } from "../daemon/disk-pressure-guard.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import { setConfig } from "./helpers/set-config.js";

// Short turn-boundary commit wait and no second-pass retitling keep the loop
// teardown fast and deterministic.
setConfig("workspaceGit", { turnCommitMaxWaitMs: 10 });
setConfig("conversations", { skipAutoRetitling: true });

// Disk pressure is disabled so the loop proceeds past the gate, marks the turn
// started, and runs the real `finally` (including the turn-boundary commit).
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

mock.module("../daemon/disk-pressure-guard.js", () => ({
  getDiskPressureStatus: () => disabledDiskPressureStatus,
}));

mock.module("../persistence/conversation-crud.js", () => ({
  setConversationProcessingStartedAt: () => {},
  isConversationProcessing: () => false,
  getConversation: () => ({
    id: "conv-fatal",
    conversationType: "background",
    source: "memory",
  }),
  getLastUserTimestampBefore: () => 0,
  getMessageById: () => null,
  getConversationOriginChannel: () => null,
  getConversationOriginInterface: () => null,
  resolveOverrideProfile: () => null,
  provenanceFromTrustContext: () => ({}),
  setConversationHistoryStrippedAt: () => {},
  updateConversationContextWindow: () => {},
  updateConversationSlackContextWatermark: () => {},
}));

import { runAgentLoopImpl } from "../daemon/conversation-agent-loop.js";

function makeCtx(overrides: Partial<Context> = {}): Conversation {
  let processing = true;
  return {
    conversationId: "conv-fatal",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    isProcessing: () => processing,
    setProcessing: (value: boolean) => {
      processing = value;
    },
    abortController: new AbortController(),
    currentRequestId: "req-fatal",
    agentLoop: {
      // Simulate a fatal agent-loop failure (e.g. an unhandled runtime crash).
      run: async () => {
        throw new Error("fatal agent loop failure");
      },
      getToolTokenBudget: () => 0,
      getResolvedTools: () => [],
      getActiveModel: () => undefined,
      compactionCircuit: new CompactionCircuit("conv-fatal"),
    } as unknown as AgentLoop,
    provider: { name: "mock-provider" } as Context["provider"],
    systemPrompt: "system",
    contextWindowManager: {
      updateConfig: () => {},
      resetOverflowRecovery: () => {},
      shouldCompact: () => ({ needed: false, estimatedTokens: 0 }),
      maybeCompact: async () => ({ compacted: false }),
    } as unknown as Context["contextWindowManager"],
    contextCompactedMessageCount: 0,
    contextCompactedAt: null,
    conversationType: "background",
    source: "memory",
    currentActiveSurfaceId: undefined,
    currentPage: undefined,
    surfaceState: new Map(),
    pendingSurfaceActions: new Map(),
    surfaceActionRequestIds: new Set<string>(),
    currentTurnSurfaces: [],
    workingDir: "/tmp",
    channelCapabilities: undefined,
    commandIntent: undefined,
    trustContext: undefined,
    allowedToolNames: undefined,
    preactivatedSkillIds: undefined,
    skillProjectionState: new Map(),
    skillProjectionCache: new Map() as Context["skillProjectionCache"],
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
    markWorkspaceTopLevelDirty: () => {},
    emitActivityState: () => {},
    getQueueDepth: () => 0,
    hasQueuedMessages: () => false,
    canHandoffAtCheckpoint: () => false,
    drainQueue: async () => {},
    getTurnInterfaceContext: () => null,
    getTurnChannelContext: () => null,
    buildCurrentSystemPrompt: () => "system prompt",
    syncLoopSystemPrompt: () => {},
    modelOverride: undefined,
    graphMemory: {} as Context["graphMemory"],
    ...overrides,
  } as unknown as Conversation;
}

type Context = Conversation;

describe("runAgentLoopImpl fatal-failure cleanup (ATL-1009)", () => {
  beforeEach(() => {
    // no-op; each test builds its own ctx
  });

  afterAll(() => {
    // restore nothing — disk pressure stays disabled for this suite
  });

  test("clears the processing flag even when the turn-boundary commit throws in the finally", async () => {
    const events: ServerMessage[] = [];
    const drainQueue = mock(async (_reason: unknown) => {});
    // The turn-boundary commit throwing inside the `finally` is precisely the
    // ATL-1007 failure mode. Before the fix this bypassed `setProcessing(false)`
    // and latched `processing_started_at`.
    const commitTurnChanges = mock(() => {
      throw new Error("commit crashed (simulated Bun memoryUsage bug)");
    });
    const ctx = makeCtx({
      drainQueue,
      commitTurnChanges:
        commitTurnChanges as unknown as Context["commitTurnChanges"],
    });

    // Must not reject: a fatal agent-loop failure is handled, not propagated.
    await runAgentLoopImpl(ctx, "background task", "msg-fatal", (event) =>
      events.push(event),
    );

    // The commit was attempted (turn was marked started before the loop threw).
    expect(commitTurnChanges).toHaveBeenCalled();
    // The processing flag was cleared despite the commit throwing — the
    // conversation is no longer wedged mid-turn.
    expect(ctx.isProcessing()).toBe(false);
    expect(ctx.abortController).toBeNull();
    expect(ctx.currentRequestId).toBeUndefined();
    // The queue was still drained so a resend can start a fresh turn.
    expect(drainQueue).toHaveBeenCalledWith("loop_complete");
    // The user still saw a terminal error for the fatal failure.
    expect(events.some((event) => event.type === "error")).toBe(true);
  });

  test("clears the processing flag on a clean fatal failure (commit succeeds)", async () => {
    const events: ServerMessage[] = [];
    const drainQueue = mock(async (_reason: unknown) => {});
    const commitTurnChanges = mock(async () => {});
    const ctx = makeCtx({
      drainQueue,
      commitTurnChanges:
        commitTurnChanges as unknown as Context["commitTurnChanges"],
    });

    await runAgentLoopImpl(ctx, "background task", "msg-fatal-2", (event) =>
      events.push(event),
    );

    expect(ctx.isProcessing()).toBe(false);
    expect(ctx.abortController).toBeNull();
    expect(drainQueue).toHaveBeenCalledWith("loop_complete");
  });
});

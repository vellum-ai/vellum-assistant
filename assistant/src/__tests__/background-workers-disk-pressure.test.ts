import { beforeEach, describe, expect, mock, test } from "bun:test";

import { createMockLoggerModule } from "./helpers/mock-logger.js";

// Default the warm-pool gate to OPEN — these tests probe background-job
// disk-pressure behavior, not the pre-first-message guard.
mock.module("../runtime/pre-first-message-gate.js", () => ({
  hasReceivedUserMessage: () => true,
  _resetPreFirstMessageGateCacheForTests: () => {},
}));

mock.module("../util/logger.js", () => createMockLoggerModule());

mock.module("../daemon/disk-pressure-background-gate.js", () => ({
  checkDiskPressureBackgroundGate: () => ({
    action: "skip",
    reason: "disk_pressure",
    blockedCapability: "background-work",
    status: {
      enabled: true,
      state: "critical",
      locked: true,
      acknowledged: true,
      overrideActive: false,
      effectivelyLocked: true,
      lockId: "disk-pressure-test",
      usagePercent: 98,
      thresholdPercent: 95,
      path: "/",
      lastCheckedAt: "2026-05-05T00:00:00.000Z",
      blockedCapabilities: ["agent-turns", "background-work", "remote-ingress"],
      error: null,
    },
  }),
  diskPressureBackgroundSkipLogFields: () => ({
    reason: "disk_pressure",
    thresholdPercent: 95,
    usagePercent: 98,
    blockedCapability: "background-work",
    lockId: "disk-pressure-test",
    path: "/",
  }),
  shouldLogDiskPressureBackgroundSkip: () => true,
}));

const mockProcessMessage = mock(() => Promise.resolve({ messageId: "msg-1" }));
mock.module("../daemon/process-message.js", () => ({
  processMessage: mockProcessMessage,
  processMessageInBackground: mock(() =>
    Promise.resolve({ messageId: "msg-bg" }),
  ),
  resolveTurnChannel: () => "vellum",
  resolveTurnInterface: () => "vellum",
}));

const createdConversations: Array<{ conversationType: string }> = [];
mock.module("../persistence/conversation-crud.js", () => ({
  setConversationProcessingStartedAt: () => {},
  isConversationProcessing: () => false,
  recordConversationPersistedSeq: () => {},
  getConversationPersistedSeq: () => null,
  addMessage: mock(() => ({ id: "msg-1" })),
  archiveConversation: mock(() => true),
  batchSetDisplayOrders: mock(() => {}),
  createConversation: (opts: { conversationType: string }) => {
    createdConversations.push(opts);
    return { id: "conv-1", ...opts };
  },
  countConversationsByScheduleJobId: mock(() => 0),
  countMessagesAfter: mock(() => 0),
  deleteMessageById: mock(() => {}),
  clearAll: mock(async () => ({ conversations: 0, messages: 0 })),
  deleteConversation: mock(() => ({ memoryIds: [] })),
  deleteConversationGently: mock(async () => ({
    segmentIds: [],
    deletedSummaryIds: [],
  })),
  deleteLastExchange: mock(() => 0),
  forkConversation: mock(() => ({ id: "conv-fork" })),
  forkConversationForRetrospective: mock(async () => ({ id: "conv-fork" })),
  getConversationOverrideProfile: () => undefined,
  resolveOverrideProfile: () => undefined,
  getConversationMemoryScopeId: () => "default",
  getConversationOriginChannel: () => null,
  getConversationOriginInterface: () => null,
  getConversationRecentProvenanceTrustClass: () => null,
  getConversationSource: () => null,
  getAssistantMessageIdsInTurn: () => [],
  getDisplayMetaForConversations: () => new Map(),
  getLastUserTimestampBefore: () => null,
  getMessageById: () => null,
  getMessages: () => [],
  getMessagesAfter: () => [],
  getMessagesPaginated: () => ({ messages: [], hasMore: false }),
  getTurnTimeBounds: () => null,
  getConversation: () => null,
  hasMessages: () => false,
  messageMetadataSchema: { parse: (value: unknown) => value },
  parseConversation: (row: unknown) => row,
  provenanceFromTrustContext: () => ({ source: "user" }),
  relinkAttachments: mock(() => {}),
  selectSlackMetaCandidateMetadata: () => null,
  setConversationOriginChannelIfUnset: mock(() => {}),
  setConversationOriginInterfaceIfUnset: mock(() => {}),
  setConversationInferenceProfile: mock(() => {}),
  unarchiveConversation: mock(() => true),
  updateMessageContent: mock(() => {}),
  updateMessageContentAndMetadata: mock(() => {}),
  updateMessageMetadata: mock(() => {}),
  updateConversationContextWindow: mock(() => {}),
  updateConversationSlackContextWatermark: mock(() => {}),
  updateConversationTitle: mock(() => {}),
  updateConversationUsage: mock(() => {}),
  setLastNotifiedInferenceProfile: mock(() => {}),
  setConversationHistoryStrippedAt: mock(() => {}),
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
  extractImageSourcePaths: () => undefined,
}));

mock.module("../persistence/conversation-title-service.js", () => ({
  GENERATING_TITLE: "Generating title...",
  AUTO_TITLE_DETERMINISTIC: 2,
  deriveDeterministicTitle: (context: { systemHint?: string }) =>
    context.systemHint ?? "Untitled Conversation",
  isReplaceableTitle: () => true,
  queueGenerateConversationTitle: () => {},
  queueRegenerateConversationTitle: () => {},
}));

const mockFailStalledJobs = mock(() => 0);
const mockClaimMemoryJobs = mock(() => []);
mock.module("../persistence/jobs-store.js", () => ({
  claimMemoryJobs: mockClaimMemoryJobs,
  completeMemoryJob: mock(() => {}),
  deferMemoryJob: mock(() => "deferred"),
  EMBED_JOB_TYPES: [],
  enqueueMemoryJob: mock(() => "job-1"),
  enqueuePruneOldConversationsJob: mock(() => "job-prune-conv"),
  enqueuePruneOldLlmRequestLogsJob: mock(() => "job-prune-llm"),
  enqueuePruneOldToolInvocationsJob: mock(() => "job-prune-tool"),
  failMemoryJob: mock(() => {}),
  failStalledJobs: mockFailStalledJobs,
  getMemoryJobCounts: mock(() => ({})),
  hasActiveJobOfType: mock(() => false),
  hasPendingJobOfType: mock(() => false),
  isMemoryEnabled: () => true,
  MEMORY_V2_CONSOLIDATION_JOB_TRIGGERS: {
    automatic: "automatic",
    manual: "manual",
  },
  MESSAGE_LEXICAL_JOB_TYPES: [],
  resetRunningJobsToPending: mock(() => 0),
  SLOW_LLM_JOB_TYPES: [],
  upsertDebouncedJob: mock(() => "job-debounced"),
  upsertMemoryRetrospectiveJob: mock(() => "job-memory-retrospective"),
}));

const mockMaybeRunDbMaintenance = mock(() => {});
const mockMaybeRunPassiveWalCheckpoint = mock(() => {});
mock.module("../persistence/db-maintenance.js", () => ({
  maybeRunDbMaintenance: mockMaybeRunDbMaintenance,
  maybeRunPassiveWalCheckpoint: mockMaybeRunPassiveWalCheckpoint,
}));

mock.module("../persistence/cleanup-schedule-state.js", () => ({
  getLastScheduledCleanupEnqueueMs: () => 0,
  markScheduledCleanupEnqueued: mock(() => {}),
}));

const { runMemoryJobsOnce } =
  await import("../plugins/defaults/memory/jobs-worker.js");
const { WorkspaceHeartbeatService } =
  await import("../workspace/heartbeat-service.js");

describe("background workers disk pressure gate", () => {
  beforeEach(() => {
    mockProcessMessage.mockClear();
    createdConversations.length = 0;
    mockFailStalledJobs.mockClear();
    mockClaimMemoryJobs.mockClear();
    mockMaybeRunDbMaintenance.mockClear();
    mockMaybeRunPassiveWalCheckpoint.mockClear();
  });

  test("memory jobs worker skips before claiming or maintenance writes", async () => {
    const processed = await runMemoryJobsOnce({ enableScheduledCleanup: true });

    expect(processed).toBe(0);
    expect(mockFailStalledJobs).not.toHaveBeenCalled();
    expect(mockClaimMemoryJobs).not.toHaveBeenCalled();
    expect(mockMaybeRunDbMaintenance).not.toHaveBeenCalled();
    expect(mockMaybeRunPassiveWalCheckpoint).not.toHaveBeenCalled();
  });

  test("workspace heartbeat skips auto-commit checks while locked", async () => {
    const getServices = mock(() => new Map());
    const heartbeat = new WorkspaceHeartbeatService({ getServices });

    const result = await heartbeat.check();

    expect(result).toEqual({ checked: 0, committed: 0, skipped: 0, failed: 0 });
    expect(getServices).not.toHaveBeenCalled();
  });
});

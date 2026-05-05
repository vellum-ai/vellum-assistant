import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () => ({
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    filing: {
      enabled: true,
      intervalMs: 60_000,
      compactionEnabled: true,
      compactionIntervalMs: 60_000,
      activeHoursStart: null,
      activeHoursEnd: null,
    },
    memory: {
      enabled: true,
      jobs: {
        stalledJobTimeoutMs: 60_000,
        slowLlmConcurrency: 1,
        fastConcurrency: 1,
        embedConcurrency: 1,
      },
      cleanup: {
        enabled: true,
        enqueueIntervalMs: 60_000,
        conversationRetentionDays: 30,
        llmRequestLogRetentionMs: 60_000,
        traceEventRetentionDays: 30,
      },
      v2: {
        enabled: false,
        consolidation_interval_hours: 4,
      },
    },
  }),
  loadConfig: () => ({}),
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  getConfigReadOnly: () => ({}),
  applyNestedDefaults: (config: unknown) => config,
  deepMergeOverwrite: (base: unknown) => base,
  mergeDefaultWorkspaceConfig: () => {},
  getNestedValue: () => undefined,
  setNestedValue: () => {},
  API_KEY_PROVIDERS: [],
  _appendQuarantineBulletin: () => {},
  invalidateConfigCache: () => {},
}));

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
mock.module("../memory/conversation-crud.js", () => ({
  addMessage: mock(() => ({ id: "msg-1" })),
  archiveConversation: mock(() => true),
  batchSetDisplayOrders: mock(() => {}),
  clearStrippedInjectionMetadataForConversation: mock(() => {}),
  createConversation: (opts: { conversationType: string }) => {
    createdConversations.push(opts);
    return { id: "conv-1", ...opts };
  },
  countConversationsByScheduleJobId: mock(() => 0),
  deleteMessageById: mock(() => {}),
  clearAll: mock(() => ({ conversations: 0, messages: 0 })),
  deleteConversation: mock(() => ({ memoryIds: [] })),
  deleteLastExchange: mock(() => 0),
  findAnalysisConversationFor: mock(() => null),
  forkConversation: mock(() => ({ id: "conv-fork" })),
  getConversationOverrideProfile: () => undefined,
  getConversationOverrideProfileFromRow: () => undefined,
  getConversationMemoryScopeId: () => "default",
  getConversationOriginChannel: () => null,
  getConversationOriginInterface: () => null,
  getConversationRecentProvenanceTrustClass: () => null,
  getConversationSource: () => null,
  getAssistantMessageIdsInTurn: () => [],
  getDisplayMetaForConversations: () => new Map(),
  getLastAssistantTimestampBefore: () => null,
  getLastUserTimestampBefore: () => null,
  getMessageById: () => null,
  getMessages: () => [],
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
  wipeConversation: mock(() => ({ memoryIds: [] })),
}));

mock.module("../memory/conversation-title-service.js", () => ({
  GENERATING_TITLE: "Generating title...",
  isReplaceableTitle: () => true,
  queueGenerateConversationTitle: () => {},
  queueRegenerateConversationTitle: () => {},
}));

const mockFailStalledJobs = mock(() => 0);
const mockClaimMemoryJobs = mock(() => []);
mock.module("../memory/jobs-store.js", () => ({
  claimMemoryJobs: mockClaimMemoryJobs,
  completeMemoryJob: mock(() => {}),
  deferMemoryJob: mock(() => "deferred"),
  EMBED_JOB_TYPES: [],
  enqueueMemoryJob: mock(() => "job-1"),
  enqueuePruneOldConversationsJob: mock(() => "job-prune-conv"),
  enqueuePruneOldLlmRequestLogsJob: mock(() => "job-prune-llm"),
  enqueuePruneOldTraceEventsJob: mock(() => "job-prune-trace"),
  failMemoryJob: mock(() => {}),
  failStalledJobs: mockFailStalledJobs,
  getMemoryJobCounts: mock(() => ({})),
  hasActiveJobOfType: mock(() => false),
  resetRunningJobsToPending: mock(() => 0),
  SLOW_LLM_JOB_TYPES: [],
  upsertAutoAnalysisJob: mock(() => "job-auto-analysis"),
  upsertDebouncedJob: mock(() => "job-debounced"),
}));

const mockMaybeRunDbMaintenance = mock(() => {});
mock.module("../memory/db-maintenance.js", () => ({
  maybeRunDbMaintenance: mockMaybeRunDbMaintenance,
}));

mock.module("../memory/cleanup-schedule-state.js", () => ({
  getLastScheduledCleanupEnqueueMs: () => 0,
  markScheduledCleanupEnqueued: mock(() => {}),
}));

const { startFeedScheduler } = await import("../home/feed-scheduler.js");
const { runMemoryJobsOnce } = await import("../memory/jobs-worker.js");
const { FilingService } = await import("../filing/filing-service.js");
const { WorkspaceHeartbeatService } =
  await import("../workspace/heartbeat-service.js");

describe("background workers disk pressure gate", () => {
  beforeEach(() => {
    mockProcessMessage.mockClear();
    createdConversations.length = 0;
    mockFailStalledJobs.mockClear();
    mockClaimMemoryJobs.mockClear();
    mockMaybeRunDbMaintenance.mockClear();
  });

  test("home feed scheduler skips producers while locked", async () => {
    const gmailDigestRunner = mock(async () => null);
    const rollupRunner = mock(async () => ({
      wroteCount: 1,
      skippedReason: "empty_items" as const,
    }));
    const handle = startFeedScheduler({
      runOnStart: false,
      gmailCountSource: async () => 0,
      gmailDigestRunner,
      rollupRunner,
    });

    const summary = await handle.runOnce(new Date("2026-05-05T12:00:00.000Z"));
    handle.stop();

    expect(summary).toEqual({ gmailDigestRan: false, rollupRan: false });
    expect(gmailDigestRunner).not.toHaveBeenCalled();
    expect(rollupRunner).not.toHaveBeenCalled();
  });

  test("memory jobs worker skips before claiming or maintenance writes", async () => {
    const processed = await runMemoryJobsOnce({ enableScheduledCleanup: true });

    expect(processed).toBe(0);
    expect(mockFailStalledJobs).not.toHaveBeenCalled();
    expect(mockClaimMemoryJobs).not.toHaveBeenCalled();
    expect(mockMaybeRunDbMaintenance).not.toHaveBeenCalled();
  });

  test("filing service skips background LLM work while locked", async () => {
    const service = new FilingService();

    const ran = await service.runOnce();
    const compacted = await service.runCompactionOnce();

    expect(ran).toBe(false);
    expect(compacted).toBe(false);
    expect(createdConversations).toHaveLength(0);
    expect(mockProcessMessage).not.toHaveBeenCalled();
  });

  test("filing service allows forced user-initiated runs while locked", async () => {
    const service = new FilingService();

    const ran = await service.runOnce({ force: true });
    const compacted = await service.runCompactionOnce({ force: true });

    expect(ran).toBe(true);
    expect(compacted).toBe(true);
    expect(createdConversations).toHaveLength(2);
    expect(mockProcessMessage).toHaveBeenCalledTimes(2);
  });

  test("workspace heartbeat skips auto-commit checks while locked", async () => {
    const getServices = mock(() => new Map());
    const heartbeat = new WorkspaceHeartbeatService({ getServices });

    const result = await heartbeat.check();

    expect(result).toEqual({ checked: 0, committed: 0, skipped: 0, failed: 0 });
    expect(getServices).not.toHaveBeenCalled();
  });
});

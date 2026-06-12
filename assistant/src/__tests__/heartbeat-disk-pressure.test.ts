import { beforeEach, describe, expect, mock, test } from "bun:test";

// Default the warm-pool gate to OPEN — these tests probe disk-pressure
// behavior, not the pre-first-message guard.
mock.module("../runtime/pre-first-message-gate.js", () => ({
  hasReceivedUserMessage: () => true,
  _resetPreFirstMessageGateCacheForTests: () => {},
}));

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
    heartbeat: {
      enabled: true,
      intervalMs: 60_000,
      cronExpression: null,
      timezone: null,
      activeHoursStart: undefined,
      activeHoursEnd: undefined,
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
  _writeQuarantineNotice: () => {},
  invalidateConfigCache: () => {},
}));

const mockInsertPendingHeartbeatRun = mock(() => "run-1");
const mockStartHeartbeatRun = mock(() => true);
const mockCompleteHeartbeatRun = mock(() => true);
const mockSkipHeartbeatRun = mock(() => true);
const mockMarkStaleRunsAsMissed = mock(() => 0);
const mockMarkStaleRunningAsError = mock(() => 0);
mock.module("../heartbeat/heartbeat-run-store.js", () => ({
  insertPendingHeartbeatRun: mockInsertPendingHeartbeatRun,
  startHeartbeatRun: mockStartHeartbeatRun,
  completeHeartbeatRun: mockCompleteHeartbeatRun,
  skipHeartbeatRun: mockSkipHeartbeatRun,
  supersedePendingRun: mock(() => true),
  markStaleRunsAsMissed: mockMarkStaleRunsAsMissed,
  markStaleRunningAsError: mockMarkStaleRunningAsError,
  countCompletedHeartbeatRuns: mock(() => 10),
  countCompletedRunsToday: mock(() => 0),
  countRecentConsecutiveRuns: mock(() => 0),
}));

mock.module("../schedule/recurrence-engine.js", () => ({
  computeNextRunAt: () => Date.now() + 60_000,
}));

const createdConversations: Array<{ conversationType: string }> = [];
mock.module("../memory/conversation-crud.js", () => ({
  getConversation: () => null,
  getMessages: () => [],
  createConversation: (opts: { conversationType: string }) => {
    createdConversations.push(opts);
    return { id: "conv-1", ...opts };
  },
  // runBackgroundJob (loaded transitively via heartbeat-service) imports
  // addMessage. Disk-pressure short-circuits before addMessage ever runs,
  // but the mock module must still expose every name the real module does.
  addMessage: () => Promise.resolve({ id: "mock-msg-id" }),
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
}));

const mockProcessMessage = mock(() => Promise.resolve({ messageId: "msg-1" }));
mock.module("../daemon/process-message.js", () => ({
  processMessage: mockProcessMessage,
}));

const emittedNotificationSignals: Array<{ sourceEventName?: string }> = [];
mock.module("../notifications/emit-signal.js", () => ({
  emitNotificationSignal: async (opts: { sourceEventName?: string }) => {
    emittedNotificationSignals.push({ sourceEventName: opts.sourceEventName });
  },
}));

mock.module("../prompts/persona-resolver.js", () => ({
  GUARDIAN_PERSONA_TEMPLATE: "# User Profile\n",
  resolveGuardianPersona: () => "# User Profile\n",
  // buildSystemPrompt now uses resolveUserSlug (for ctx) instead of
  // resolvePersonaContext — give the mock a noop so the import
  // doesn't fail.
  resolveUserSlug: () => null,
}));

mock.module("../memory/conversation-title-service.js", () => ({
  GENERATING_TITLE: "Generating title...",
  AUTO_TITLE_DETERMINISTIC: 2,
  deriveDeterministicTitle: (context: { systemHint?: string }) =>
    context.systemHint ?? "Untitled Conversation",
  queueGenerateConversationTitle: () => {},
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

const { HeartbeatService } = await import("../heartbeat/heartbeat-service.js");

describe("HeartbeatService disk pressure gate", () => {
  beforeEach(() => {
    createdConversations.length = 0;
    mockInsertPendingHeartbeatRun.mockClear();
    mockStartHeartbeatRun.mockClear();
    mockCompleteHeartbeatRun.mockClear();
    mockSkipHeartbeatRun.mockClear();
    mockMarkStaleRunsAsMissed.mockClear();
    mockMarkStaleRunsAsMissed.mockImplementation(() => 0);
    mockMarkStaleRunningAsError.mockClear();
    mockMarkStaleRunningAsError.mockImplementation(() => 0);
    mockProcessMessage.mockClear();
    emittedNotificationSignals.length = 0;
  });

  test("skips without creating heartbeat rows, conversations, or notifications", async () => {
    const service = new HeartbeatService({
      alerter: () => {},
    });

    const ran = await service.runOnce();

    expect(ran).toBe(false);
    expect(mockInsertPendingHeartbeatRun).not.toHaveBeenCalled();
    expect(mockStartHeartbeatRun).not.toHaveBeenCalled();
    expect(mockCompleteHeartbeatRun).not.toHaveBeenCalled();
    expect(mockSkipHeartbeatRun).not.toHaveBeenCalled();
    expect(createdConversations).toHaveLength(0);
    expect(mockProcessMessage).not.toHaveBeenCalled();
    expect(emittedNotificationSignals).toHaveLength(0);
  });

  test("allows forced user-initiated heartbeat runs while locked", async () => {
    const service = new HeartbeatService({
      alerter: () => {},
    });

    const ran = await service.runOnce({ force: true });

    expect(ran).toBe(true);
    expect(mockStartHeartbeatRun).toHaveBeenCalled();
    expect(mockCompleteHeartbeatRun).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: "ok" }),
    );
    expect(createdConversations).toHaveLength(1);
    expect(mockProcessMessage).toHaveBeenCalledTimes(1);
  });

  test("start recovery skips missed-run notifications while locked", async () => {
    mockMarkStaleRunsAsMissed.mockImplementationOnce(() => 1);
    const service = new HeartbeatService({
      alerter: () => {},
    });

    service.start();
    await service.stop();

    expect(mockMarkStaleRunsAsMissed).toHaveBeenCalledTimes(1);
    expect(emittedNotificationSignals).toHaveLength(0);
  });
});

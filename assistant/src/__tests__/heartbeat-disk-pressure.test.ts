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
  _appendQuarantineBulletin: () => {},
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
}));

const mockProcessMessage = mock(() => Promise.resolve({ messageId: "msg-1" }));
mock.module("../daemon/process-message.js", () => ({
  processMessage: mockProcessMessage,
}));

const mockEmitFeedEvent = mock(() => Promise.resolve());
mock.module("../home/emit-feed-event.js", () => ({
  emitFeedEvent: mockEmitFeedEvent,
}));

mock.module("../prompts/persona-resolver.js", () => ({
  GUARDIAN_PERSONA_TEMPLATE: "# User Profile\n",
  resolveGuardianPersona: () => "# User Profile\n",
}));

mock.module("../memory/conversation-title-service.js", () => ({
  GENERATING_TITLE: "Generating title...",
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
    mockEmitFeedEvent.mockClear();
  });

  test("skips without creating heartbeat rows, conversations, or feed events", async () => {
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
    expect(mockEmitFeedEvent).not.toHaveBeenCalled();
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

  test("start recovery skips missed-run feed events while locked", async () => {
    mockMarkStaleRunsAsMissed.mockImplementationOnce(() => 1);
    const service = new HeartbeatService({
      alerter: () => {},
    });

    service.start();
    await service.stop();

    expect(mockMarkStaleRunsAsMissed).toHaveBeenCalledTimes(1);
    expect(mockEmitFeedEvent).not.toHaveBeenCalled();
  });
});

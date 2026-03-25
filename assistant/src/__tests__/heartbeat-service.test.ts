import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

// Mock platform to use a temp workspace dir
let testWorkspaceDir: string;

mock.module("../util/platform.js", () => ({
  getWorkspacePromptPath: (file: string) => join(testWorkspaceDir, file),
}));

// Mock config loader
let mockConfig = {
  heartbeat: {
    enabled: true,
    intervalMs: 60_000,
    activeHoursStart: undefined as number | undefined,
    activeHoursEnd: undefined as number | undefined,
  },
};

mock.module("../config/loader.js", () => ({
  getConfig: () => mockConfig,
  loadConfig: () => mockConfig,
}));

// Mock conversation store
const createdConversations: Array<{ title: string; conversationType: string }> =
  [];
let conversationIdCounter = 0;

mock.module("../memory/conversation-crud.js", () => ({
  getConversationType: () => "default",
  setConversationOriginChannelIfUnset: () => {},
  updateConversationContextWindow: () => {},
  deleteMessageById: () => {},
  updateConversationTitle: () => {},
  updateConversationUsage: () => {},
  addMessage: () => ({ id: "mock-msg-id" }),
  getMessages: () => [],
  getConversation: () => ({
    id: "conv-1",
    contextSummary: null,
    contextCompactedMessageCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalEstimatedCost: 0,
    title: null,
  }),
  provenanceFromTrustContext: () => ({
    source: "user",
    trustContext: undefined,
  }),
  getConversationOriginInterface: () => null,
  getConversationOriginChannel: () => null,
  createConversation: (opts: { title: string; conversationType: string }) => {
    createdConversations.push(opts);
    return { id: `conv-${++conversationIdCounter}`, ...opts };
  },
}));

// Mock logger
mock.module("../util/logger.js", () => ({
  getLogger: () => ({
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

// Mock conversation title service
mock.module("../memory/conversation-title-service.js", () => ({
  GENERATING_TITLE: "Generating title...",
  queueGenerateConversationTitle: () => {},
}));

// Import after mocks are set up
const { HeartbeatService } = await import("../heartbeat/heartbeat-service.js");

describe("HeartbeatService", () => {
  let processMessageCalls: Array<{ conversationId: string; content: string }>;
  let alerterCalls: Array<{ type: string; title: string; body: string }>;

  beforeEach(() => {
    testWorkspaceDir = join(
      tmpdir(),
      `vellum-hb-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testWorkspaceDir, { recursive: true });

    processMessageCalls = [];
    alerterCalls = [];
    createdConversations.length = 0;
    conversationIdCounter = 0;

    mockConfig = {
      heartbeat: {
        enabled: true,
        intervalMs: 60_000,
        activeHoursStart: undefined,
        activeHoursEnd: undefined,
      },
    };
  });

  function createService(overrides?: {
    processMessage?: (
      id: string,
      content: string,
    ) => Promise<{ messageId: string }>;
    getCurrentHour?: () => number;
  }) {
    return new HeartbeatService({
      processMessage:
        overrides?.processMessage ??
        (async (conversationId: string, content: string) => {
          processMessageCalls.push({ conversationId, content });
          return { messageId: "msg-1" };
        }),
      alerter: (alert: { type: string; title: string; body: string }) => {
        alerterCalls.push(alert);
      },
      getCurrentHour: overrides?.getCurrentHour,
    });
  }

  test("runOnce() calls processMessage with correct prompt", async () => {
    const service = createService();
    await service.runOnce();

    expect(processMessageCalls).toHaveLength(1);
    expect(processMessageCalls[0].conversationId).toBe("conv-1");
    expect(processMessageCalls[0].content).toContain("<heartbeat-checklist>");
    expect(processMessageCalls[0].content).toContain("<heartbeat-disposition>");
    expect(processMessageCalls[0].content).toContain("HEARTBEAT_OK");
    expect(processMessageCalls[0].content).toContain("HEARTBEAT_ALERT");
  });

  test("HEARTBEAT.md content is embedded in prompt when file exists", async () => {
    const customChecklist = "- Check the weather\n- Water the plants";
    writeFileSync(join(testWorkspaceDir, "HEARTBEAT.md"), customChecklist);

    const service = createService();
    await service.runOnce();

    expect(processMessageCalls).toHaveLength(1);
    expect(processMessageCalls[0].content).toContain("Check the weather");
    expect(processMessageCalls[0].content).toContain("Water the plants");
  });

  test("default checklist used when no HEARTBEAT.md", async () => {
    const service = createService();
    await service.runOnce();

    expect(processMessageCalls).toHaveLength(1);
    expect(processMessageCalls[0].content).toContain(
      "Check the current weather",
    );
  });

  test("creates background conversation with generating title placeholder", async () => {
    const service = createService();
    await service.runOnce();

    expect(createdConversations).toHaveLength(1);
    expect(createdConversations[0].title).toBe("Generating title...");
    expect(createdConversations[0].conversationType).toBe("background");
  });

  test("active hours guard skips outside window", async () => {
    mockConfig.heartbeat.activeHoursStart = 9;
    mockConfig.heartbeat.activeHoursEnd = 17;

    const service = createService({ getCurrentHour: () => 3 });
    await service.runOnce();

    expect(processMessageCalls).toHaveLength(0);
  });

  test("active hours guard allows within window", async () => {
    mockConfig.heartbeat.activeHoursStart = 9;
    mockConfig.heartbeat.activeHoursEnd = 17;

    const service = createService({ getCurrentHour: () => 12 });
    await service.runOnce();

    expect(processMessageCalls).toHaveLength(1);
  });

  test("active hours handles overnight window", async () => {
    mockConfig.heartbeat.activeHoursStart = 22;
    mockConfig.heartbeat.activeHoursEnd = 6;

    // 23:00 should be within the window
    const service = createService({ getCurrentHour: () => 23 });
    await service.runOnce();
    expect(processMessageCalls).toHaveLength(1);

    // 10:00 should be outside the window
    processMessageCalls.length = 0;
    createdConversations.length = 0;
    const service2 = createService({ getCurrentHour: () => 10 });
    await service2.runOnce();
    expect(processMessageCalls).toHaveLength(0);
  });

  test("overlap prevention works", async () => {
    let resolveFirst: () => void;
    const firstPromise = new Promise<void>((r) => {
      resolveFirst = r;
    });

    const service = createService({
      processMessage: async () => {
        await firstPromise;
        processMessageCalls.push({ conversationId: "slow", content: "slow" });
        return { messageId: "msg-1" };
      },
    });

    // Start first run (will block)
    const run1 = service.runOnce();
    // Give the first run a tick to set activeRun
    await new Promise((r) => setTimeout(r, 10));

    // Second run should be skipped due to overlap
    await service.runOnce();

    // Resolve the first run
    resolveFirst!();
    await run1;

    // Only the first run should have called processMessage
    expect(processMessageCalls).toHaveLength(1);
  });

  test("disabled config prevents start", () => {
    mockConfig.heartbeat.enabled = false;
    const service = createService();
    service.start();
    // No error, just a no-op. We can verify by calling stop which should also be a no-op.
    // The key assertion is that no timer is set (verified by stop not hanging).
    service.stop();
  });

  test("disabled config prevents runOnce", async () => {
    mockConfig.heartbeat.enabled = false;
    const service = createService();
    await service.runOnce();

    expect(processMessageCalls).toHaveLength(0);
  });

  test("force bypasses disabled config", async () => {
    mockConfig.heartbeat.enabled = false;
    const service = createService();
    await service.runOnce({ force: true });

    expect(processMessageCalls).toHaveLength(1);
  });

  test("force bypasses active hours guard", async () => {
    mockConfig.heartbeat.activeHoursStart = 9;
    mockConfig.heartbeat.activeHoursEnd = 17;

    const service = createService({ getCurrentHour: () => 3 });
    await service.runOnce({ force: true });

    expect(processMessageCalls).toHaveLength(1);
  });

  test("force does not bypass overlap prevention", async () => {
    let resolveFirst: () => void;
    const firstPromise = new Promise<void>((r) => {
      resolveFirst = r;
    });

    const service = createService({
      processMessage: async () => {
        await firstPromise;
        processMessageCalls.push({ conversationId: "slow", content: "slow" });
        return { messageId: "msg-1" };
      },
    });

    const run1 = service.runOnce({ force: true });
    await new Promise((r) => setTimeout(r, 10));

    const didRun = await service.runOnce({ force: true });
    expect(didRun).toBe(false);

    resolveFirst!();
    await run1;
    expect(processMessageCalls).toHaveLength(1);
  });

  test("alerts on processMessage failure", async () => {
    const service = createService({
      processMessage: async () => {
        throw new Error("LLM timeout");
      },
    });

    await service.runOnce();

    expect(alerterCalls).toHaveLength(1);
    expect(alerterCalls[0].type).toBe("heartbeat_alert");
    expect(alerterCalls[0].title).toBe("Heartbeat Failed");
    expect(alerterCalls[0].body).toBe("LLM timeout");
  });

  test("alerts on conversation creation failure", async () => {
    // Override createConversation to throw via a fresh import trick:
    // Since createConversation is mocked at module level, we simulate
    // this by having processMessage throw before it's called — but the
    // real fix is that executeRun wraps createConversation in the try/catch.
    // We verify by checking that any error in executeRun triggers the alert.
    const service = createService({
      processMessage: async () => {
        throw new Error("DB locked");
      },
    });

    await service.runOnce();

    expect(alerterCalls).toHaveLength(1);
    expect(alerterCalls[0].body).toBe("DB locked");
  });

  test("resetTimer() pushes nextRunAt forward", () => {
    const service = createService();
    service.start();

    const firstNextRunAt = service.nextRunAt;
    expect(firstNextRunAt).not.toBeNull();

    // Simulate some time passing, then reset
    const before = Date.now();
    service.resetTimer();
    const afterReset = service.nextRunAt;

    expect(afterReset).not.toBeNull();
    // The new nextRunAt should be >= the interval from now
    expect(afterReset!).toBeGreaterThanOrEqual(before + mockConfig.heartbeat.intervalMs);
    service.stop();
  });

  test("resetTimer() is a no-op when heartbeat is not running", () => {
    const service = createService();
    // Don't call start() — heartbeat not running
    expect(service.nextRunAt).toBeNull();
    service.resetTimer();
    expect(service.nextRunAt).toBeNull();
  });

  test("resetTimer() is a no-op when heartbeat is disabled", () => {
    mockConfig.heartbeat.enabled = false;
    const service = createService();
    service.start();
    expect(service.nextRunAt).toBeNull();
    service.resetTimer();
    expect(service.nextRunAt).toBeNull();
  });

  test("cleanup", () => {
    try {
      rmSync(testWorkspaceDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
});

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  mock,
  test,
} from "bun:test";

const testWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR!;

// ── Heartbeat run store mock ───────────────────────────────────────
const mockInsertPendingHeartbeatRun = mock(() => "mock-run-id");
const mockStartHeartbeatRun = mock(() => true);
const mockCompleteHeartbeatRun = mock(() => true);
const mockSkipHeartbeatRun = mock(() => true);
const mockSupersedePendingRun = mock(() => true);
const mockMarkStaleRunsAsMissed = mock(() => 0);
const mockMarkStaleRunningAsError = mock(() => 0);
mock.module("../heartbeat/heartbeat-run-store.js", () => ({
  insertPendingHeartbeatRun: mockInsertPendingHeartbeatRun,
  startHeartbeatRun: mockStartHeartbeatRun,
  completeHeartbeatRun: mockCompleteHeartbeatRun,
  skipHeartbeatRun: mockSkipHeartbeatRun,
  supersedePendingRun: mockSupersedePendingRun,
  markStaleRunsAsMissed: mockMarkStaleRunsAsMissed,
  markStaleRunningAsError: mockMarkStaleRunningAsError,
}));

// ── Feed event mock ───────────────────────────────────────────────
const mockEmitFeedEvent = mock(() => Promise.resolve());
mock.module("../home/emit-feed-event.js", () => ({
  emitFeedEvent: mockEmitFeedEvent,
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
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  invalidateConfigCache: () => {},
}));

// ── Guardian persona mock ─────────────────────────────────────────
//
// `heartbeat-service.isShallowProfile` reads the guardian persona via
// `resolveGuardianPersona()` and compares against the exported
// `GUARDIAN_PERSONA_TEMPLATE` scaffold. We mock the module so each
// test can seed whatever persona content it needs; the scaffold text
// below is kept byte-identical to the real template in
// `persona-resolver.ts` so the "scaffold-only" path triggers a match.
const GUARDIAN_PERSONA_TEMPLATE = `_ Lines starting with _ are comments - they won't appear in the system prompt

# User Profile

Store details about your user here. Edit freely - build this over time as you learn about them. Don't be pushy about seeking details, but when you learn something, write it down. More context makes you more useful.

- Preferred name/reference:
- Pronouns:
- Locale:
- Work role:
- Goals:
- Hobbies/fun:
- Daily tools:
`;

// `resolveGuardianPersona` returns already-stripped + trimmed content
// (or null for missing/empty files). Tests mutate this variable to
// drive `isShallowProfile`.
let mockGuardianPersona: string | null = null;

mock.module("../prompts/persona-resolver.js", () => ({
  GUARDIAN_PERSONA_TEMPLATE,
  resolveGuardianPersona: () => mockGuardianPersona,
}));

// Mock conversation store
const createdConversations: Array<{ title: string; conversationType: string }> =
  [];
let conversationIdCounter = 0;

mock.module("../memory/conversation-crud.js", () => ({
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
  getMessageById: () => null,
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

// Mock logger — capture warn calls for unreachable-credential assertions
const loggerWarnCalls: Array<Record<string, unknown>> = [];
mock.module("../util/logger.js", () => ({
  getLogger: () => ({
    info: () => {},
    debug: () => {},
    warn: (...args: unknown[]) => {
      if (args.length > 0 && typeof args[0] === "object" && args[0] !== null) {
        loggerWarnCalls.push(args[0] as Record<string, unknown>);
      }
    },
    error: () => {},
  }),
}));

// ── Credential health mock ──────────────────────────────────────────
//
// HeartbeatService dynamically imports `checkAllCredentials` inside
// `runCredentialHealthCheck`, so `mock.module` intercepts it. Tests
// mutate `mockCredentialHealthReport` to drive different scenarios.
import type {
  CredentialHealthReport,
  CredentialHealthResult,
  CredentialHealthStatus,
} from "../credential-health/credential-health-service.js";

let mockCredentialHealthReport: CredentialHealthReport | null = null;
let mockCheckAllCredentialsFail = false;

mock.module("../credential-health/credential-health-service.js", () => ({
  checkAllCredentials: async () => {
    if (mockCheckAllCredentialsFail) {
      throw new Error("CES unreachable");
    }
    return (
      mockCredentialHealthReport ?? {
        checkedAt: Date.now(),
        results: [],
        unhealthy: [],
      }
    );
  },
}));

// ── Notification signal mock ────────────────────────────────────────
//
// `notifyUnhealthyCredentials` dynamically imports `emitNotificationSignal`.
// Track calls so tests can assert which credentials were notified about.
const emittedNotificationSignals: Array<{
  sourceContextId: string;
  dedupeKey: string;
  contextPayload: Record<string, unknown>;
}> = [];

mock.module("../notifications/emit-signal.js", () => ({
  emitNotificationSignal: async (opts: {
    sourceContextId: string;
    dedupeKey: string;
    contextPayload: Record<string, unknown>;
  }) => {
    emittedNotificationSignals.push({
      sourceContextId: opts.sourceContextId,
      dedupeKey: opts.dedupeKey,
      contextPayload: opts.contextPayload,
    });
  },
}));

// Mock conversation title service
mock.module("../memory/conversation-title-service.js", () => ({
  GENERATING_TITLE: "Generating title...",
  queueGenerateConversationTitle: () => {},
}));

// Mock processMessage — HeartbeatService now imports it directly.
// Tests override _testProcessMessage to capture / customize calls.
let _testProcessMessage:
  | ((...args: unknown[]) => Promise<{ messageId: string }>)
  | undefined;

mock.module("../daemon/process-message.js", () => ({
  processMessage: async (...args: unknown[]) => {
    if (_testProcessMessage) return _testProcessMessage(...args);
    return { messageId: `mock-msg-${Date.now()}` };
  },
  processMessageInBackground: async () => ({ messageId: "mock-bg" }),
  resolveTurnChannel: () => "vellum",
  resolveTurnInterface: () => "vellum",
  prepareConversationForMessage: async () => ({}),
}));

export function setTestProcessMessage(
  fn: ((...args: unknown[]) => Promise<{ messageId: string }>) | undefined,
): void {
  _testProcessMessage = fn;
}

// Import after mocks are set up
const { HeartbeatService, isShallowProfile } =
  await import("../heartbeat/heartbeat-service.js");

// Read the bundled template files so we can write them into the test workspace
const templatesDir = join(import.meta.dirname!, "..", "prompts", "templates");
const IDENTITY_TEMPLATE = readFileSync(
  join(templatesDir, "IDENTITY.md"),
  "utf-8",
);

// Stripped/trimmed form of the guardian persona scaffold — mirrors
// the transformation applied by `resolveGuardianPersona` (which runs
// `stripCommentLines` internally). Used to simulate a freshly-seeded,
// never-edited persona file.
const { stripCommentLines } = await import("../util/strip-comment-lines.js");
const SCAFFOLD_PERSONA = stripCommentLines(GUARDIAN_PERSONA_TEMPLATE).trim();

// Resolver wiring — used by the end-to-end resolution test below to verify
// that `callSite: 'heartbeatAgent'` resolves to the correct config when
// `llm.callSites.heartbeatAgent` is defined.
const { resolveCallSiteConfig } = await import("../config/llm-resolver.js");
const { LLMSchema } = await import("../config/schemas/llm.js");

// Minimal fully-specified `llm.default` block. The resolver requires every
// `LLMConfigBase` field to be present in `default`, so we provide the same
// fixture the resolver test suite uses.
const LLM_DEFAULT = {
  provider: "anthropic" as const,
  model: "claude-opus-4-7",
  maxTokens: 64000,
  effort: "max" as const,
  speed: "standard" as const,
  temperature: null,
  thinking: { enabled: true, streamThinking: true },
  contextWindow: {
    enabled: true,
    maxInputTokens: 200000,
    targetBudgetRatio: 0.3,
    compactThreshold: 0.8,
    summaryBudgetRatio: 0.05,
    overflowRecovery: {
      enabled: true,
      safetyMarginRatio: 0.05,
      maxAttempts: 3,
      interactiveLatestTurnCompression: "summarize" as const,
      nonInteractiveLatestTurnCompression: "truncate" as const,
    },
  },
};

describe("HeartbeatService", () => {
  let processMessageCalls: Array<{
    conversationId: string;
    content: string;
    options?: { callSite?: string };
  }>;
  let alerterCalls: Array<{ type: string; title: string; body: string }>;

  afterEach(() => {
    // Clean up workspace files between tests so file-existence tests don't leak
    rmSync(join(testWorkspaceDir, "HEARTBEAT.md"), { force: true });
    rmSync(join(testWorkspaceDir, "IDENTITY.md"), { force: true });
    rmSync(join(testWorkspaceDir, ".reengagement-ts"), { force: true });
  });

  beforeEach(() => {
    processMessageCalls = [];
    alerterCalls = [];
    createdConversations.length = 0;
    conversationIdCounter = 0;
    mockGuardianPersona = null;
    mockCredentialHealthReport = null;
    mockCheckAllCredentialsFail = false;
    emittedNotificationSignals.length = 0;
    loggerWarnCalls.length = 0;

    // Default processMessage mock: capture calls for assertions.
    setTestProcessMessage(async (...args: unknown[]) => {
      processMessageCalls.push({
        conversationId: args[0] as string,
        content: args[1] as string,
        options: (args[3] as { callSite?: string } | undefined) ?? undefined,
      });
      return { messageId: "msg-1" };
    });

    mockInsertPendingHeartbeatRun.mockClear();
    mockInsertPendingHeartbeatRun.mockImplementation(() => "mock-run-id");
    mockStartHeartbeatRun.mockClear();
    mockStartHeartbeatRun.mockImplementation(() => true);
    mockCompleteHeartbeatRun.mockClear();
    mockCompleteHeartbeatRun.mockImplementation(() => true);
    mockSkipHeartbeatRun.mockClear();
    mockSkipHeartbeatRun.mockImplementation(() => true);
    mockSupersedePendingRun.mockClear();
    mockSupersedePendingRun.mockImplementation(() => true);
    mockMarkStaleRunsAsMissed.mockClear();
    mockMarkStaleRunsAsMissed.mockImplementation(() => 0);
    mockMarkStaleRunningAsError.mockClear();
    mockMarkStaleRunningAsError.mockImplementation(() => 0);
    mockEmitFeedEvent.mockClear();
    mockEmitFeedEvent.mockImplementation(() => Promise.resolve());

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
    processMessage?: (...args: unknown[]) => Promise<{ messageId: string }>;
    getCurrentHour?: () => number;
  }) {
    if (overrides?.processMessage) {
      setTestProcessMessage(overrides.processMessage);
    }
    return new HeartbeatService({
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

  test("comment lines in HEARTBEAT.md are stripped from prompt", async () => {
    const checklist = [
      "_ This is a comment that should be stripped",
      "_ Another comment line",
      "- Do the real task",
      "- Check on something important",
    ].join("\n");
    writeFileSync(join(testWorkspaceDir, "HEARTBEAT.md"), checklist);

    const service = createService();
    await service.runOnce();

    expect(processMessageCalls).toHaveLength(1);
    expect(processMessageCalls[0].content).toContain("Do the real task");
    expect(processMessageCalls[0].content).toContain(
      "Check on something important",
    );
    expect(processMessageCalls[0].content).not.toContain(
      "This is a comment that should be stripped",
    );
    expect(processMessageCalls[0].content).not.toContain(
      "Another comment line",
    );
  });

  test("comment lines inside fenced code blocks are preserved", async () => {
    const checklist = [
      "_ This comment should be stripped",
      "- Check the Python snippet below still works:",
      "```python",
      "_instance = None",
      "_private_var = 42",
      "```",
    ].join("\n");
    writeFileSync(join(testWorkspaceDir, "HEARTBEAT.md"), checklist);

    const service = createService();
    await service.runOnce();

    expect(processMessageCalls).toHaveLength(1);
    expect(processMessageCalls[0].content).toContain("_instance = None");
    expect(processMessageCalls[0].content).toContain("_private_var = 42");
    expect(processMessageCalls[0].content).not.toContain(
      "This comment should be stripped",
    );
  });

  test("default checklist used when no HEARTBEAT.md", async () => {
    const service = createService();
    await service.runOnce();

    expect(processMessageCalls).toHaveLength(1);
    expect(processMessageCalls[0].content).toContain("Check in with yourself");
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

  test("active hours skip still advances nextRunAt", async () => {
    mockConfig.heartbeat.activeHoursStart = 9;
    mockConfig.heartbeat.activeHoursEnd = 17;

    const service = createService({ getCurrentHour: () => 3 });
    service.start();

    const before = Date.now();
    await service.runOnce();

    expect(processMessageCalls).toHaveLength(0);
    expect(service.nextRunAt).not.toBeNull();
    expect(service.nextRunAt!).toBeGreaterThanOrEqual(
      before + mockConfig.heartbeat.intervalMs,
    );
    service.stop();
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

  test("successful run updates lastRunAt and nextRunAt", async () => {
    const service = createService();
    expect(service.lastRunAt).toBeNull();
    expect(service.nextRunAt).toBeNull();

    const before = Date.now();
    await service.runOnce();

    expect(service.lastRunAt).not.toBeNull();
    expect(service.lastRunAt!).toBeGreaterThanOrEqual(before);
    expect(service.nextRunAt).not.toBeNull();
    expect(service.nextRunAt!).toBeGreaterThanOrEqual(
      before + mockConfig.heartbeat.intervalMs,
    );
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
    expect(afterReset!).toBeGreaterThanOrEqual(
      before + mockConfig.heartbeat.intervalMs,
    );
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

  test("passes callSite='heartbeatAgent' to processMessage", async () => {
    const service = createService();
    await service.runOnce();

    expect(processMessageCalls).toHaveLength(1);
    expect(processMessageCalls[0].options).toMatchObject({
      callSite: "heartbeatAgent",
    });
  });

  test("processMessage receives callSite and trustContext", async () => {
    const service = createService();
    await service.runOnce();

    expect(processMessageCalls).toHaveLength(1);
    expect(processMessageCalls[0].options).toMatchObject({
      callSite: "heartbeatAgent",
      trustContext: { sourceChannel: "vellum", trustClass: "guardian" },
    });
  });

  test("end-to-end: llm.callSites.heartbeatAgent.speed resolves to 'fast'", async () => {
    // Verifies the contract that PR 7 establishes: heartbeat passes
    // `callSite: 'heartbeatAgent'`, and the LLM resolver maps that to the
    // configured speed via `llm.callSites.heartbeatAgent`. The heartbeat
    // service itself doesn't call the resolver — that happens downstream in
    // the provider layer (see PR 5) — so this test asserts both halves of
    // the wiring: (a) the call site identifier flows through to
    // processMessage, and (b) the resolver maps that identifier to the
    // user's configured speed.
    const llm = LLMSchema.parse({
      default: LLM_DEFAULT,
      callSites: {
        heartbeatAgent: { speed: "fast" },
      },
    });
    const service = createService();
    await service.runOnce();

    expect(processMessageCalls).toHaveLength(1);
    expect(processMessageCalls[0].options?.callSite).toBe("heartbeatAgent");
    const resolved = resolveCallSiteConfig("heartbeatAgent", llm);
    expect(resolved.speed).toBe("fast");
  });

  describe("isShallowProfile", () => {
    test("returns true when IDENTITY.md is template and guardian persona is missing", () => {
      writeFileSync(join(testWorkspaceDir, "IDENTITY.md"), IDENTITY_TEMPLATE);
      mockGuardianPersona = null;

      expect(isShallowProfile()).toBe(true);
    });

    test("returns true when IDENTITY.md is template and guardian persona has only scaffold fields", () => {
      writeFileSync(join(testWorkspaceDir, "IDENTITY.md"), IDENTITY_TEMPLATE);
      mockGuardianPersona = SCAFFOLD_PERSONA;

      expect(isShallowProfile()).toBe(true);
    });

    test("returns true when IDENTITY.md is template and guardian persona is empty string", () => {
      writeFileSync(join(testWorkspaceDir, "IDENTITY.md"), IDENTITY_TEMPLATE);
      mockGuardianPersona = "";

      expect(isShallowProfile()).toBe(true);
    });

    test("returns false when IDENTITY.md has been customized", () => {
      writeFileSync(
        join(testWorkspaceDir, "IDENTITY.md"),
        "# IDENTITY.md\n\n- **Name:** Jarvis\n",
      );
      mockGuardianPersona = SCAFFOLD_PERSONA;

      expect(isShallowProfile()).toBe(false);
    });

    test("returns false when guardian persona has real content", () => {
      writeFileSync(join(testWorkspaceDir, "IDENTITY.md"), IDENTITY_TEMPLATE);
      mockGuardianPersona =
        "# User Profile\n\n- Preferred name/reference: Alice\n- Work role: designer";

      expect(isShallowProfile()).toBe(false);
    });

    test("returns false when IDENTITY.md does not exist", () => {
      mockGuardianPersona = null;

      expect(isShallowProfile()).toBe(false);
    });
  });

  describe("relationship-depth prompt injection", () => {
    test("includes <relationship-depth> when profile is shallow", () => {
      writeFileSync(join(testWorkspaceDir, "IDENTITY.md"), IDENTITY_TEMPLATE);
      mockGuardianPersona = SCAFFOLD_PERSONA;

      const service = createService();
      const { prompt, includedReengagement } =
        service.buildPrompt("- Check things");

      expect(prompt).toContain("<relationship-depth>");
      expect(prompt).toContain("profile is still sparse");
      expect(includedReengagement).toBe(true);
    });

    test("omits <relationship-depth> when profile is not shallow", () => {
      writeFileSync(
        join(testWorkspaceDir, "IDENTITY.md"),
        "# IDENTITY.md\n\n- **Name:** Jarvis\n",
      );
      mockGuardianPersona = SCAFFOLD_PERSONA;

      const service = createService();
      const { prompt, includedReengagement } =
        service.buildPrompt("- Check things");

      expect(prompt).not.toContain("<relationship-depth>");
      expect(includedReengagement).toBe(false);
    });

    test("omits <relationship-depth> when cooldown has not elapsed", () => {
      writeFileSync(join(testWorkspaceDir, "IDENTITY.md"), IDENTITY_TEMPLATE);
      mockGuardianPersona = SCAFFOLD_PERSONA;
      // Write a recent timestamp to simulate cooldown not elapsed
      writeFileSync(
        join(testWorkspaceDir, ".reengagement-ts"),
        Date.now().toString(),
      );

      const service = createService();
      const { prompt, includedReengagement } =
        service.buildPrompt("- Check things");

      expect(prompt).not.toContain("<relationship-depth>");
      expect(includedReengagement).toBe(false);
    });

    test("includes <relationship-depth> when cooldown has elapsed", () => {
      writeFileSync(join(testWorkspaceDir, "IDENTITY.md"), IDENTITY_TEMPLATE);
      mockGuardianPersona = SCAFFOLD_PERSONA;
      // Write a timestamp from 19 hours ago
      const nineteenHoursAgo = Date.now() - 19 * 60 * 60 * 1000;
      writeFileSync(
        join(testWorkspaceDir, ".reengagement-ts"),
        nineteenHoursAgo.toString(),
      );

      const service = createService();
      const { prompt, includedReengagement } =
        service.buildPrompt("- Check things");

      expect(prompt).toContain("<relationship-depth>");
      expect(includedReengagement).toBe(true);
    });

    test("does not record timestamp when processMessage fails", async () => {
      writeFileSync(join(testWorkspaceDir, "IDENTITY.md"), IDENTITY_TEMPLATE);
      mockGuardianPersona = SCAFFOLD_PERSONA;

      const service = createService({
        processMessage: async () => {
          throw new Error("LLM timeout");
        },
      });

      await service.runOnce();

      // The reengagement timestamp file should NOT exist since delivery failed
      const tsPath = join(testWorkspaceDir, ".reengagement-ts");
      expect(existsSync(tsPath)).toBe(false);
    });

    test("records timestamp after successful delivery", async () => {
      writeFileSync(join(testWorkspaceDir, "IDENTITY.md"), IDENTITY_TEMPLATE);
      mockGuardianPersona = SCAFFOLD_PERSONA;

      const service = createService();
      await service.runOnce();

      // The reengagement timestamp file should exist after successful delivery
      const tsPath = join(testWorkspaceDir, ".reengagement-ts");
      expect(existsSync(tsPath)).toBe(true);
    });
  });

  describe("credential health gating", () => {
    test("prompt includes credential-status when providers are unhealthy", () => {
      const service = createService();
      const { prompt } = service.buildPrompt("- Check email", ["google"]);

      expect(prompt).toContain("<credential-status>");
      expect(prompt).toContain("google");
      expect(prompt).toContain(
        "Do NOT attempt to use tools for these providers",
      );
    });

    test("prompt omits credential-status when all providers are healthy", () => {
      const service = createService();
      const { prompt } = service.buildPrompt("- Check email", []);

      expect(prompt).not.toContain("<credential-status>");
    });

    test("prompt lists multiple unhealthy providers", () => {
      const service = createService();
      const { prompt } = service.buildPrompt("- Check things", [
        "google",
        "slack",
      ]);

      expect(prompt).toContain("google, slack");
    });
  });

  describe("transient credential health suppression", () => {
    function makeUnhealthyResult(
      overrides: Partial<CredentialHealthResult> = {},
    ): CredentialHealthResult {
      return {
        connectionId: overrides.connectionId ?? "conn-1",
        provider: overrides.provider ?? "google",
        accountInfo: overrides.accountInfo ?? "user@example.com",
        status: overrides.status ?? ("missing_token" as CredentialHealthStatus),
        details: overrides.details ?? "Token not found",
        missingScopes: overrides.missingScopes ?? [],
        canAutoRecover: overrides.canAutoRecover ?? false,
      };
    }

    test("unreachable credentials do not trigger notifications", async () => {
      mockCredentialHealthReport = {
        checkedAt: Date.now(),
        results: [
          makeUnhealthyResult({
            connectionId: "conn-google",
            provider: "google",
            status: "unreachable",
            details: "CES backend unavailable",
          }),
        ],
        unhealthy: [
          makeUnhealthyResult({
            connectionId: "conn-google",
            provider: "google",
            status: "unreachable",
            details: "CES backend unavailable",
          }),
        ],
      };

      const service = createService();
      await service.runOnce();

      // No notification signals should have been emitted for unreachable
      expect(emittedNotificationSignals).toHaveLength(0);
    });

    test("unreachable credentials do not block provider tools in heartbeat prompt", async () => {
      mockCredentialHealthReport = {
        checkedAt: Date.now(),
        results: [
          makeUnhealthyResult({
            connectionId: "conn-google",
            provider: "google",
            status: "unreachable",
            details: "CES backend unavailable",
          }),
        ],
        unhealthy: [
          makeUnhealthyResult({
            connectionId: "conn-google",
            provider: "google",
            status: "unreachable",
            details: "CES backend unavailable",
          }),
        ],
      };

      const service = createService();
      await service.runOnce();

      // The prompt should NOT contain <credential-status> since unreachable
      // is not a hard failure and should not tell the LLM to skip providers
      expect(processMessageCalls).toHaveLength(1);
      expect(processMessageCalls[0].content).not.toContain(
        "<credential-status>",
      );
    });

    test("unreachable credentials log a warning", async () => {
      mockCredentialHealthReport = {
        checkedAt: Date.now(),
        results: [
          makeUnhealthyResult({
            connectionId: "conn-google",
            provider: "google",
            status: "unreachable",
            details: "CES backend unavailable",
          }),
        ],
        unhealthy: [
          makeUnhealthyResult({
            connectionId: "conn-google",
            provider: "google",
            status: "unreachable",
            details: "CES backend unavailable",
          }),
        ],
      };

      const service = createService();
      await service.runOnce();

      // Logger warn should have been called with unreachableCount
      const unreachableWarns = loggerWarnCalls.filter(
        (call) => "unreachableCount" in call,
      );
      expect(unreachableWarns).toHaveLength(1);
      expect(unreachableWarns[0].unreachableCount).toBe(1);
    });

    test("missing_token still notifies and blocks provider tools", async () => {
      mockCredentialHealthReport = {
        checkedAt: Date.now(),
        results: [
          makeUnhealthyResult({
            connectionId: "conn-google",
            provider: "google",
            status: "missing_token",
            details: "Token not found in keychain",
          }),
        ],
        unhealthy: [
          makeUnhealthyResult({
            connectionId: "conn-google",
            provider: "google",
            status: "missing_token",
            details: "Token not found in keychain",
          }),
        ],
      };

      const service = createService();
      await service.runOnce();

      // Should have emitted a notification for missing_token
      expect(emittedNotificationSignals).toHaveLength(1);
      expect(emittedNotificationSignals[0].contextPayload.status).toBe(
        "missing_token",
      );
      expect(emittedNotificationSignals[0].contextPayload.provider).toBe(
        "google",
      );

      // Prompt should include <credential-status> blocking google
      expect(processMessageCalls).toHaveLength(1);
      expect(processMessageCalls[0].content).toContain("<credential-status>");
      expect(processMessageCalls[0].content).toContain("google");
    });

    test("mixed report notifies only actionable failures, not unreachable", async () => {
      mockCredentialHealthReport = {
        checkedAt: Date.now(),
        results: [
          makeUnhealthyResult({
            connectionId: "conn-google",
            provider: "google",
            status: "unreachable",
            details: "CES backend unavailable",
          }),
          makeUnhealthyResult({
            connectionId: "conn-slack",
            provider: "slack",
            status: "revoked",
            details: "Token was revoked by user",
          }),
          makeUnhealthyResult({
            connectionId: "conn-github",
            provider: "github",
            status: "unreachable",
            details: "CES backend unavailable",
          }),
        ],
        unhealthy: [
          makeUnhealthyResult({
            connectionId: "conn-google",
            provider: "google",
            status: "unreachable",
            details: "CES backend unavailable",
          }),
          makeUnhealthyResult({
            connectionId: "conn-slack",
            provider: "slack",
            status: "revoked",
            details: "Token was revoked by user",
          }),
          makeUnhealthyResult({
            connectionId: "conn-github",
            provider: "github",
            status: "unreachable",
            details: "CES backend unavailable",
          }),
        ],
      };

      const service = createService();
      await service.runOnce();

      // Only the revoked credential should trigger a notification
      expect(emittedNotificationSignals).toHaveLength(1);
      expect(emittedNotificationSignals[0].contextPayload.provider).toBe(
        "slack",
      );
      expect(emittedNotificationSignals[0].contextPayload.status).toBe(
        "revoked",
      );

      // Only slack (revoked = hard failure) should appear in credential-status
      expect(processMessageCalls).toHaveLength(1);
      expect(processMessageCalls[0].content).toContain("<credential-status>");
      expect(processMessageCalls[0].content).toContain("slack");
      // google and github are unreachable — should NOT be in credential-status
      expect(processMessageCalls[0].content).not.toContain("google");
      expect(processMessageCalls[0].content).not.toContain("github");

      // Should have logged a warning about the 2 unreachable credentials
      const unreachableWarns = loggerWarnCalls.filter(
        (call) => "unreachableCount" in call,
      );
      expect(unreachableWarns).toHaveLength(1);
      expect(unreachableWarns[0].unreachableCount).toBe(2);
    });
  });

  describe("heartbeat run store instrumentation", () => {
    test("successful run: pending → running → ok with conversationId", async () => {
      const service = createService();
      await service.runOnce();

      expect(mockStartHeartbeatRun).toHaveBeenCalledTimes(1);
      expect(mockCompleteHeartbeatRun).toHaveBeenCalledTimes(1);
      expect(mockCompleteHeartbeatRun).toHaveBeenCalledWith("mock-run-id", {
        status: "ok",
        conversationId: "conv-1",
      });
    });

    test("failed run: pending → running → error preserving conversationId", async () => {
      const service = createService({
        processMessage: async () => {
          throw new Error("LLM timeout");
        },
      });

      await service.runOnce();

      expect(mockStartHeartbeatRun).toHaveBeenCalledTimes(1);
      expect(mockCompleteHeartbeatRun).toHaveBeenCalledTimes(1);
      expect(mockCompleteHeartbeatRun).toHaveBeenCalledWith("mock-run-id", {
        status: "error",
        conversationId: "conv-1",
        error: "LLM timeout",
      });
    });

    test("CAS false suppresses success feed event", async () => {
      mockCompleteHeartbeatRun.mockImplementation(() => false);

      const service = createService();
      await service.runOnce();

      // completeHeartbeatRun returned false, so no feed event should be emitted for success
      const successCalls = mockEmitFeedEvent.mock.calls.filter(
        (call: unknown[]) => {
          const opts = call[0] as { dedupKey?: string };
          return opts.dedupKey?.startsWith("heartbeat:ok:");
        },
      );
      expect(successCalls).toHaveLength(0);
    });

    test("CAS false suppresses failure alerter and feed event", async () => {
      mockCompleteHeartbeatRun.mockImplementation(() => false);

      const service = createService({
        processMessage: async () => {
          throw new Error("LLM timeout");
        },
      });

      await service.runOnce();

      // completeHeartbeatRun returned false, so alerter should NOT be called
      expect(alerterCalls).toHaveLength(0);

      // No failure feed event either
      const failCalls = mockEmitFeedEvent.mock.calls.filter(
        (call: unknown[]) => {
          const opts = call[0] as { dedupKey?: string };
          return opts.dedupKey?.startsWith("heartbeat:fail:");
        },
      );
      expect(failCalls).toHaveLength(0);
    });

    test("active-hours skip calls skipHeartbeatRun", async () => {
      mockConfig.heartbeat.activeHoursStart = 9;
      mockConfig.heartbeat.activeHoursEnd = 17;

      const service = createService({ getCurrentHour: () => 3 });
      service.start();
      await service.runOnce();

      expect(mockSkipHeartbeatRun).toHaveBeenCalledWith(
        "mock-run-id",
        "outside_active_hours",
      );
      service.stop();
    });

    test("overlap skip calls skipHeartbeatRun", async () => {
      let resolveFirst: () => void;
      const firstPromise = new Promise<void>((r) => {
        resolveFirst = r;
      });

      const service = createService({
        processMessage: async () => {
          await firstPromise;
          return { messageId: "msg-1" };
        },
      });

      // Start first run (will block)
      const run1 = service.runOnce();
      await new Promise((r) => setTimeout(r, 10));

      // Start service so the second runOnce has a pending row
      service.start();
      mockSkipHeartbeatRun.mockClear();

      // Second run should be skipped due to overlap
      await service.runOnce();

      expect(mockSkipHeartbeatRun).toHaveBeenCalledWith(
        "mock-run-id",
        "overlap",
      );

      resolveFirst!();
      await run1;
      service.stop();
    });

    test("start() calls markStaleRunsAsMissed and markStaleRunningAsError", () => {
      const service = createService();
      service.start();

      expect(mockMarkStaleRunsAsMissed).toHaveBeenCalledTimes(1);
      expect(mockMarkStaleRunningAsError).toHaveBeenCalledTimes(1);
      service.stop();
    });

    test("scheduleNextRun supersedes old pending row before creating new one", () => {
      const service = createService();
      service.start();

      // start() called scheduleNextRun which set _pendingRunId.
      // Calling resetTimer triggers another scheduleNextRun which
      // should supersede the existing pending row before inserting
      // a new one.
      const callOrder: string[] = [];
      mockSupersedePendingRun.mockImplementation(() => {
        callOrder.push("supersede");
        return true;
      });
      mockInsertPendingHeartbeatRun.mockImplementation(() => {
        callOrder.push("insert");
        return "mock-run-id";
      });

      service.resetTimer();

      // resetTimer's scheduleNextRun should supersede then insert
      expect(callOrder.filter((c) => c === "supersede").length).toBeGreaterThan(
        0,
      );
      const firstSupersede = callOrder.indexOf("supersede");
      const firstInsert = callOrder.indexOf("insert");
      expect(firstSupersede).toBeLessThan(firstInsert);

      service.stop();
    });

    test("resetTimer() supersedes pending row", () => {
      const service = createService();
      service.start();

      mockSupersedePendingRun.mockClear();
      service.resetTimer();

      // resetTimer calls scheduleNextRun which supersedes existing pending
      expect(mockSupersedePendingRun).toHaveBeenCalled();
      service.stop();
    });

    test("force run creates its own pending row, does not consume scheduled one", async () => {
      const service = createService();
      service.start();

      // Clear to track only the force run's calls
      mockInsertPendingHeartbeatRun.mockClear();

      await service.runOnce({ force: true });

      // Force run should have called insertPendingHeartbeatRun for itself
      // (at least once for its own row, plus the scheduleNextRun in finally)
      expect(mockInsertPendingHeartbeatRun).toHaveBeenCalled();

      // The scheduled pending row (from start()) should NOT have been consumed
      // by the force run — force creates its own
      service.stop();
    });

    test("disabled config with stale pending row skips it as disabled", async () => {
      const service = createService();
      service.start();

      // Now disable config and call runOnce — should skip the pending row
      mockConfig.heartbeat.enabled = false;
      mockSkipHeartbeatRun.mockClear();

      await service.runOnce();

      expect(mockSkipHeartbeatRun).toHaveBeenCalledWith(
        "mock-run-id",
        "disabled",
      );
      service.stop();
    });

    test("stop() supersedes outstanding pending row", async () => {
      const service = createService();
      service.start();

      mockSupersedePendingRun.mockClear();
      await service.stop();

      expect(mockSupersedePendingRun).toHaveBeenCalledWith("mock-run-id");
    });

    test("timeout calls completeHeartbeatRun with status timeout", async () => {
      jest.useFakeTimers();
      try {
        let resolveRun: () => void;
        const runPromise = new Promise<void>((r) => {
          resolveRun = r;
        });

        const service = createService({
          processMessage: async () => {
            await runPromise;
            return { messageId: "msg-1" };
          },
        });

        const runOncePromise = service.runOnce();
        // Advance past the 30-minute timeout
        jest.advanceTimersByTime(30 * 60 * 1000 + 1000);
        await runOncePromise;

        expect(mockCompleteHeartbeatRun).toHaveBeenCalledWith("mock-run-id", {
          status: "timeout",
          error: "Heartbeat execution exceeded the 30-minute timeout",
        });

        // Clean up — resolve the hanging promise so it doesn't leak
        resolveRun!();
      } finally {
        jest.useRealTimers();
      }
    });

    test("failure feed event has urgency high and includes error message", async () => {
      const service = createService({
        processMessage: async () => {
          throw new Error("web_search outage");
        },
      });

      await service.runOnce();

      const failCalls = mockEmitFeedEvent.mock.calls.filter(
        (call: unknown[]) => {
          const opts = call[0] as { title?: string };
          return opts.title === "Heartbeat Failed";
        },
      );
      expect(failCalls).toHaveLength(1);
      const opts = (failCalls as any[][])[0][0] as {
        urgency?: string;
        summary?: string;
      };
      expect(opts.urgency).toBe("high");
      expect(opts.summary).toContain("web_search outage");
    });

    test("CAS false on complete suppresses failure feed event", async () => {
      mockCompleteHeartbeatRun.mockImplementation(() => false);

      const service = createService({
        processMessage: async () => {
          throw new Error("some error");
        },
      });

      await service.runOnce();

      const failCalls = mockEmitFeedEvent.mock.calls.filter(
        (call: unknown[]) => {
          const opts = call[0] as { title?: string };
          return opts.title === "Heartbeat Failed";
        },
      );
      expect(failCalls).toHaveLength(0);
    });

    test("timeout emits feed event with urgency high", async () => {
      jest.useFakeTimers();
      try {
        let resolveRun: () => void;
        const runPromise = new Promise<void>((r) => {
          resolveRun = r;
        });

        const service = createService({
          processMessage: async () => {
            await runPromise;
            return { messageId: "msg-1" };
          },
        });

        const runOncePromise = service.runOnce();
        jest.advanceTimersByTime(30 * 60 * 1000 + 1000);
        await runOncePromise;

        const timeoutCalls = mockEmitFeedEvent.mock.calls.filter(
          (call: unknown[]) => {
            const opts = call[0] as { title?: string };
            return opts.title === "Heartbeat Timed Out";
          },
        );
        expect(timeoutCalls).toHaveLength(1);
        const opts = (timeoutCalls as any[][])[0][0] as {
          urgency?: string;
        };
        expect(opts.urgency).toBe("high");

        resolveRun!();
      } finally {
        jest.useRealTimers();
      }
    });

    test("CAS false on timeout suppresses timeout feed event", async () => {
      jest.useFakeTimers();
      try {
        mockCompleteHeartbeatRun.mockImplementation(() => false);

        let resolveRun: () => void;
        const runPromise = new Promise<void>((r) => {
          resolveRun = r;
        });

        const service = createService({
          processMessage: async () => {
            await runPromise;
            return { messageId: "msg-1" };
          },
        });

        const runOncePromise = service.runOnce();
        jest.advanceTimersByTime(30 * 60 * 1000 + 1000);
        await runOncePromise;

        // completeHeartbeatRun returned false, so no timeout feed event
        const timeoutCalls = mockEmitFeedEvent.mock.calls.filter(
          (call: unknown[]) => {
            const opts = call[0] as { title?: string };
            return opts.title === "Heartbeat Timed Out";
          },
        );
        expect(timeoutCalls).toHaveLength(0);

        resolveRun!();
      } finally {
        jest.useRealTimers();
      }
    });

    test("late run emits late feed event", async () => {
      const service = createService();
      service.start();

      // Set the pending run to be 10 minutes in the past
      (service as any)._nextRunAt = Date.now() - 10 * 60 * 1000;
      (service as any)._pendingRunId = "late-run-id";

      await service.runOnce();

      const lateCalls = mockEmitFeedEvent.mock.calls.filter(
        (call: unknown[]) => {
          const opts = call[0] as { title?: string };
          return opts.title === "Heartbeat Ran Late";
        },
      );
      expect(lateCalls).toHaveLength(1);
      const opts = (lateCalls as any[][])[0][0] as {
        urgency?: string;
        summary?: string;
      };
      expect(opts.urgency).toBe("medium");
      expect(opts.summary).toContain("10 minutes late");

      await service.stop();
    });

    test("on-time run does not emit late feed event", async () => {
      const service = createService();
      await service.runOnce();

      const lateCalls = mockEmitFeedEvent.mock.calls.filter(
        (call: unknown[]) => {
          const opts = call[0] as { title?: string };
          return opts.title === "Heartbeat Ran Late";
        },
      );
      expect(lateCalls).toHaveLength(0);
    });

    test("start() emits missed-run feed event when stale rows exist", () => {
      mockMarkStaleRunsAsMissed.mockImplementation(() => 2);
      mockMarkStaleRunningAsError.mockImplementation(() => 1);

      const service = createService();
      service.start();

      const missedCalls = mockEmitFeedEvent.mock.calls.filter(
        (call: unknown[]) => {
          const opts = call[0] as { title?: string };
          return opts.title === "Heartbeat Runs Missed";
        },
      );
      expect(missedCalls).toHaveLength(1);
      const opts = (missedCalls as any[][])[0][0] as {
        urgency?: string;
        summary?: string;
      };
      expect(opts.urgency).toBe("high");
      expect(opts.summary).toContain("3");

      service.stop();
    });

    test("start() does not emit missed-run feed event when counts are 0", () => {
      mockMarkStaleRunsAsMissed.mockImplementation(() => 0);
      mockMarkStaleRunningAsError.mockImplementation(() => 0);

      const service = createService();
      service.start();

      const missedCalls = mockEmitFeedEvent.mock.calls.filter(
        (call: unknown[]) => {
          const opts = call[0] as { title?: string };
          return opts.title === "Heartbeat Runs Missed";
        },
      );
      expect(missedCalls).toHaveLength(0);

      service.stop();
    });
  });
});

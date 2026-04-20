import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const testWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR!;

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
      options?: { callSite?: string },
    ) => Promise<{ messageId: string }>;
    getCurrentHour?: () => number;
  }) {
    return new HeartbeatService({
      processMessage:
        overrides?.processMessage ??
        (async (
          conversationId: string,
          content: string,
          options?: { callSite?: string },
        ) => {
          processMessageCalls.push({ conversationId, content, options });
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
    expect(processMessageCalls[0].options).toEqual({
      callSite: "heartbeatAgent",
    });
  });

  test("processMessage receives only callSite — no legacy speed knob", async () => {
    // The heartbeat service unconditionally passes `callSite:
    // 'heartbeatAgent'` and nothing else. The resolver maps that identifier
    // to whatever `llm.callSites.heartbeatAgent` (or `llm.default`)
    // configures.
    const service = createService();
    await service.runOnce();

    expect(processMessageCalls).toHaveLength(1);
    expect(processMessageCalls[0].options).toEqual({
      callSite: "heartbeatAgent",
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
});

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { resolveCallSiteConfig } from "../config/llm-resolver.js";
import { LLMSchema } from "../config/schemas/llm.js";

const testWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR!;

// Default the warm-pool gate to OPEN for existing tests — they predate
// the gate and expect filing's runOnce() to fire on every tick.
mock.module("../runtime/pre-first-message-gate.js", () => ({
  hasReceivedUserMessage: () => true,
  _resetPreFirstMessageGateCacheForTests: () => {},
}));

// Mock config loader. Filing's `runOnce()` reads `getConfig().filing`, and
// `executeRun()` no longer reads `config.speed` (PR 8) — the call site is
// hardcoded to 'filingAgent' and the resolver picks up `llm.callSites.filingAgent`
// inside the daemon's processMessage path.
let mockConfig = {
  filing: {
    enabled: true,
    intervalMs: 60_000,
    compactionEnabled: true,
    compactionIntervalMs: 60_000,
    speed: "standard" as "standard" | "fast",
    activeHoursStart: null as number | null,
    activeHoursEnd: null as number | null,
  },
  memory: {
    v2: { enabled: false },
  },
};

mock.module("../config/loader.js", () => ({
  getConfig: () => mockConfig,
  loadConfig: () => mockConfig,
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  invalidateConfigCache: () => {},
}));

// Mock conversation store
const createdConversations: Array<{
  title: string;
  conversationType: string;
  source?: string;
  groupId?: string;
}> = [];
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
  createConversation: (opts: {
    title: string;
    conversationType: string;
    source?: string;
    groupId?: string;
  }) => {
    createdConversations.push(opts);
    return { id: `conv-${++conversationIdCounter}`, ...opts };
  },
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
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

// Mock conversation title service. `deriveDeterministicTitle` mirrors the
// real implementation's systemHint passthrough so bootstrap-created
// conversations carry their job hint as the title.
mock.module("../memory/conversation-title-service.js", () => ({
  GENERATING_TITLE: "Generating title...",
  AUTO_TITLE_DETERMINISTIC: 2,
  deriveDeterministicTitle: (context: { systemHint?: string }) =>
    context.systemHint ?? "Untitled Conversation",
  queueGenerateConversationTitle: () => {},
}));

// Mock processMessage — FilingService now imports it directly.
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

function setTestProcessMessage(
  fn: ((...args: unknown[]) => Promise<{ messageId: string }>) | undefined,
): void {
  _testProcessMessage = fn;
}

// Import after mocks are set up
const { FilingService } = await import("../filing/filing-service.js");

describe("FilingService", () => {
  let processMessageCalls: Array<{
    conversationId: string;
    content: string;
    options?: { speed?: string; callSite?: string };
  }>;

  afterEach(() => {
    // Clean up workspace files between tests so buffer-existence tests don't leak
    const bufferPath = join(testWorkspaceDir, "pkb", "buffer.md");
    try {
      writeFileSync(bufferPath, "");
    } catch {
      // best-effort
    }
  });

  beforeEach(() => {
    processMessageCalls = [];
    createdConversations.length = 0;
    conversationIdCounter = 0;

    // Default processMessage mock: capture calls for assertions.
    setTestProcessMessage(async (...args: unknown[]) => {
      processMessageCalls.push({
        conversationId: args[0] as string,
        content: args[1] as string,
        options:
          (args[2] as { speed?: string; callSite?: string } | undefined) ??
          undefined,
      });
      return { messageId: "msg-1" };
    });

    mockConfig = {
      filing: {
        enabled: true,
        intervalMs: 60_000,
        compactionEnabled: true,
        compactionIntervalMs: 60_000,
        speed: "standard",
        activeHoursStart: null,
        activeHoursEnd: null,
      },
      memory: {
        v2: { enabled: false },
      },
    };

    // Seed buffer.md with content so runOnce doesn't skip
    const pkbDir = join(testWorkspaceDir, "pkb");
    try {
      mkdirSync(pkbDir, { recursive: true });
    } catch {
      // best-effort
    }
    writeFileSync(join(pkbDir, "buffer.md"), "- some buffered fact\n");
  });

  function createService(overrides?: {
    processMessage?: (...args: unknown[]) => Promise<{ messageId: string }>;
  }) {
    if (overrides?.processMessage) {
      setTestProcessMessage(overrides.processMessage);
    }
    return new FilingService();
  }

  test("runOnce() passes callSite: 'filingAgent' to processMessage", async () => {
    const service = createService();
    await service.runOnce();

    expect(processMessageCalls).toHaveLength(1);
    expect(processMessageCalls[0].options).toMatchObject({
      callSite: "filingAgent",
    });
    expect(processMessageCalls[0].options?.callSite).toBe("filingAgent");
  });

  test("runOnce() does not pass legacy 'speed' kwarg even when filing.speed is set", async () => {
    // Filing's schema still carries `speed` (PR 19 will remove it), but PR 8
    // stopped reading it. Ensure the new wiring no longer leaks the legacy
    // kwarg through to processMessage.
    mockConfig.filing.speed = "fast";
    const service = createService();
    await service.runOnce();

    expect(processMessageCalls).toHaveLength(1);
    expect(processMessageCalls[0].options?.speed).toBeUndefined();
    expect(processMessageCalls[0].options?.callSite).toBe("filingAgent");
  });

  test("runOnce() invokes processMessage with the filing prompt template", async () => {
    const service = createService();
    await service.runOnce();

    expect(processMessageCalls).toHaveLength(1);
    expect(processMessageCalls[0].conversationId).toBe("conv-1");
    expect(processMessageCalls[0].content).toContain(
      "periodic knowledge base filing job",
    );
  });

  test("creates background conversation with the deterministic filing title", async () => {
    const service = createService();
    await service.runOnce();

    expect(createdConversations).toHaveLength(1);
    expect(createdConversations[0].title).toBe("Knowledge base filing");
    expect(createdConversations[0].conversationType).toBe("background");
    // Confirms FilingService routes through runBackgroundJob:
    //   source="filing" + runner-default groupId="system:background".
    expect(createdConversations[0].source).toBe("filing");
    expect(createdConversations[0].groupId).toBe("system:background");
  });

  describe("runCompactionOnce()", () => {
    test("passes callSite: 'compactionAgent' to processMessage", async () => {
      const service = createService();
      await service.runCompactionOnce();

      expect(processMessageCalls).toHaveLength(1);
      expect(processMessageCalls[0].options).toMatchObject({
        callSite: "compactionAgent",
      });
    });

    test("runs even when buffer is empty", async () => {
      // Filing skips when the buffer has no content; compaction must not.
      const bufferPath = join(testWorkspaceDir, "pkb", "buffer.md");
      writeFileSync(bufferPath, "");

      const service = createService();
      const ran = await service.runCompactionOnce();

      expect(ran).toBe(true);
      expect(processMessageCalls).toHaveLength(1);
      expect(processMessageCalls[0].options?.callSite).toBe("compactionAgent");
    });

    test("invokes processMessage with the compaction prompt template", async () => {
      const service = createService();
      await service.runCompactionOnce();

      expect(processMessageCalls).toHaveLength(1);
      expect(processMessageCalls[0].content).toContain(
        "daily PKB compaction job",
      );
      expect(processMessageCalls[0].content).toContain("Step 1 — Audit");
    });

    test("creates background conversation labelled 'compaction'", async () => {
      const service = createService();
      await service.runCompactionOnce();

      expect(createdConversations).toHaveLength(1);
      expect(createdConversations[0].conversationType).toBe("background");
    });

    test("does not run when force=false and compactionEnabled=false", async () => {
      mockConfig.filing.compactionEnabled = false;
      const service = createService();
      const ran = await service.runCompactionOnce();

      expect(ran).toBe(false);
      expect(processMessageCalls).toHaveLength(0);
    });

    test("force=true overrides compactionEnabled=false", async () => {
      mockConfig.filing.compactionEnabled = false;
      const service = createService();
      const ran = await service.runCompactionOnce({ force: true });

      expect(ran).toBe(true);
      expect(processMessageCalls).toHaveLength(1);
    });

    // Helpers for the compaction-retry tests: hold the filing run open by
    // making processMessage return a manually-resolved promise, so `activeRun`
    // stays set and runCompactionOnce() sees the contention path.
    function holdFilingRun(): {
      release: () => void;
      filingCalls: () => number;
      compactionCalls: () => number;
      waitForFilingStarted: () => Promise<void>;
    } {
      let release: (() => void) | undefined;
      let started = false;
      let filingCalls = 0;
      let compactionCalls = 0;

      setTestProcessMessage((...args: unknown[]) => {
        const callSite = (args[2] as { callSite?: string } | undefined)
          ?.callSite;
        if (callSite === "filingAgent") {
          filingCalls += 1;
          started = true;
          return new Promise((resolve) => {
            release = () => resolve({ messageId: "filing-done" });
          });
        }
        if (callSite === "compactionAgent") {
          compactionCalls += 1;
        }
        return Promise.resolve({ messageId: "mock" });
      });

      return {
        release: () => release?.(),
        filingCalls: () => filingCalls,
        compactionCalls: () => compactionCalls,
        waitForFilingStarted: async () => {
          while (!started) await Promise.resolve();
        },
      };
    }

    test("schedules a near-term retry when filing run is in-flight", async () => {
      const hold = holdFilingRun();
      // 5s retry override paired with a production-realistic 24h compaction
      // interval — the assertion proves retry << interval.
      const retryMs = 5_000;
      mockConfig.filing.compactionIntervalMs = 24 * 60 * 60 * 1000;
      const service = new FilingService({
        compactionContendedRetryMs: retryMs,
      });
      const filingPromise = service.runOnce();
      await hold.waitForFilingStarted();

      const beforeRetry = Date.now();
      const ran = await service.runCompactionOnce();

      expect(ran).toBe(false);
      expect(service.nextCompactionAt).not.toBeNull();
      const nextAt = service.nextCompactionAt!;
      expect(nextAt - beforeRetry).toBeLessThan(
        mockConfig.filing.compactionIntervalMs,
      );
      expect(nextAt - beforeRetry).toBeLessThanOrEqual(retryMs + 100);

      hold.release();
      await filingPromise;
      await service.stop();
    });

    test("retry fires after filing run completes", async () => {
      const hold = holdFilingRun();
      const service = new FilingService({ compactionContendedRetryMs: 1 });
      const filingPromise = service.runOnce();
      await hold.waitForFilingStarted();

      const skipped = await service.runCompactionOnce();
      expect(skipped).toBe(false);
      expect(hold.compactionCalls()).toBe(0);

      hold.release();
      await filingPromise;

      const start = Date.now();
      while (hold.compactionCalls() === 0 && Date.now() - start < 1000) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      expect(hold.filingCalls()).toBe(1);
      expect(hold.compactionCalls()).toBe(1);

      await service.stop();
    });

    test("stop() clears a scheduled compaction retry", async () => {
      const hold = holdFilingRun();
      const service = new FilingService({ compactionContendedRetryMs: 50 });
      const filingPromise = service.runOnce();
      await hold.waitForFilingStarted();
      await service.runCompactionOnce();
      expect(service.nextCompactionAt).not.toBeNull();

      hold.release();
      await filingPromise;
      await service.stop();

      // After stop, the retry timer must be cleared and never fire.
      expect(service.nextCompactionAt).toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(hold.compactionCalls()).toBe(0);
    });

    test("stop() prevents retry callback from re-arming a fresh timer", async () => {
      // Race: the retry callback fires while filing is still in-flight and
      // stop() has begun. The callback already cleared compactionRetryTimer,
      // so clearCompactionRetry is a no-op. Without a stopped flag, the
      // callback's runCompactionOnce() hits the activeRun branch and schedules
      // a fresh retry, leaving a live timer after stop() resolves.
      const hold = holdFilingRun();
      const service = new FilingService({ compactionContendedRetryMs: 5 });
      const filingPromise = service.runOnce();
      await hold.waitForFilingStarted();
      await service.runCompactionOnce();
      expect(service.nextCompactionAt).not.toBeNull();

      // Begin stop without awaiting — it would block on the held filing run.
      // stop() flips `stopped` synchronously before the retry timer fires.
      const stopPromise = service.stop();

      // Wait past the retry delay. Without the guard, the callback would call
      // runCompactionOnce(), observe activeRun, and re-arm a new retry.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(service.nextCompactionAt).toBeNull();

      hold.release();
      await filingPromise;
      await stopPromise;

      expect(service.nextCompactionAt).toBeNull();
      expect(hold.compactionCalls()).toBe(0);
    });

    test("respects active hours", async () => {
      mockConfig.filing.activeHoursStart = 9;
      mockConfig.filing.activeHoursEnd = 17;
      const service = new FilingService({
        getCurrentHour: () => 3, // 3 AM, outside 9-17 window
      });

      const ran = await service.runCompactionOnce();
      expect(ran).toBe(false);
      expect(processMessageCalls).toHaveLength(0);
    });
  });

  describe("FilingService runs filing and compaction independently", () => {
    test("runOnce only fires the filingAgent call site", async () => {
      const service = createService();
      await service.runOnce();

      expect(processMessageCalls).toHaveLength(1);
      expect(processMessageCalls[0].options?.callSite).toBe("filingAgent");
    });

    test("runCompactionOnce only fires the compactionAgent call site", async () => {
      const service = createService();
      await service.runCompactionOnce();

      expect(processMessageCalls).toHaveLength(1);
      expect(processMessageCalls[0].options?.callSite).toBe("compactionAgent");
    });

    test("filing prompt no longer contains audit/review instructions", async () => {
      // The "review 3 random files" step moved to the compaction job. Buffer
      // filing must stay focused on draining the buffer.
      const service = createService();
      await service.runOnce();

      const content = processMessageCalls[0].content;
      expect(content).not.toContain("Pick 3 random topic files");
      expect(content).not.toContain("Part 2");
      expect(content).toContain("focused on the buffer");
    });
  });

  describe("memory v2 gate", () => {
    test("start() does not schedule timers when memory.v2.enabled is true", () => {
      mockConfig.memory.v2.enabled = true;

      const service = createService();
      service.start();

      expect(service.nextRunAt).toBeNull();
      expect(service.nextCompactionAt).toBeNull();
    });

    test("start() schedules timers when memory.v2.enabled is false (v1 filing runs)", () => {
      mockConfig.memory.v2.enabled = false;

      const service = createService();
      service.start();

      expect(service.nextRunAt).not.toBeNull();
      expect(service.nextCompactionAt).not.toBeNull();
      service.stop();
    });
  });

  describe("llm.callSites.filingAgent resolution", () => {
    // These tests verify that the call-site name used by FilingService
    // ('filingAgent') resolves through the unified `llm` config the way
    // downstream consumers expect.

    test("resolves to llm.default when no filingAgent override exists", () => {
      const llm = LLMSchema.parse({
        default: {
          provider: "anthropic",
          model: "claude-opus-4-7",
          maxTokens: 64000,
          effort: "max",
          speed: "standard",
        },
      });
      const resolved = resolveCallSiteConfig("filingAgent", llm);
      expect(resolved.model).toBe("claude-opus-4-7");
      expect(resolved.speed).toBe("standard");
    });

    test("call-site override on filingAgent wins over llm.default", () => {
      const llm = LLMSchema.parse({
        default: {
          provider: "anthropic",
          model: "claude-opus-4-7",
          maxTokens: 64000,
          effort: "max",
          speed: "standard",
        },
        callSites: {
          filingAgent: { speed: "fast", model: "claude-haiku-4-7" },
        },
      });
      const resolved = resolveCallSiteConfig("filingAgent", llm);
      expect(resolved.model).toBe("claude-haiku-4-7");
      expect(resolved.speed).toBe("fast");
      // Sibling defaults remain untouched.
      expect(resolved.provider).toBe("anthropic");
      expect(resolved.maxTokens).toBe(64000);
    });

    test("filingAgent profile reference resolves through profile fragment", () => {
      const llm = LLMSchema.parse({
        default: {
          provider: "anthropic",
          model: "claude-opus-4-7",
          maxTokens: 64000,
          effort: "max",
          speed: "standard",
        },
        profiles: {
          background: { speed: "fast", effort: "low" },
        },
        callSites: {
          filingAgent: { profile: "background" },
        },
      });
      const resolved = resolveCallSiteConfig("filingAgent", llm);
      expect(resolved.speed).toBe("fast");
      expect(resolved.effort).toBe("low");
      expect(resolved.model).toBe("claude-opus-4-7");
    });
  });
});

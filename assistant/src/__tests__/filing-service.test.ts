import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { resolveCallSiteConfig } from "../config/llm-resolver.js";
import { LLMSchema } from "../config/schemas/llm.js";

const testWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR!;

// Mock config loader. Filing's `runOnce()` reads `getConfig().filing`, and
// `executeRun()` no longer reads `config.speed` (PR 8) — the call site is
// hardcoded to 'filingAgent' and the resolver picks up `llm.callSites.filingAgent`
// inside the daemon's processMessage path.
let mockConfig = {
  filing: {
    enabled: true,
    intervalMs: 60_000,
    speed: "standard" as "standard" | "fast",
    activeHoursStart: null as number | null,
    activeHoursEnd: null as number | null,
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

    mockConfig = {
      filing: {
        enabled: true,
        intervalMs: 60_000,
        speed: "standard",
        activeHoursStart: null,
        activeHoursEnd: null,
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
    processMessage?: (
      id: string,
      content: string,
      options?: { speed?: string; callSite?: string },
    ) => Promise<{ messageId: string }>;
  }) {
    return new FilingService({
      processMessage:
        overrides?.processMessage ??
        (async (
          conversationId: string,
          content: string,
          options?: { speed?: string; callSite?: string },
        ) => {
          processMessageCalls.push({ conversationId, content, options });
          return { messageId: "msg-1" };
        }),
    });
  }

  test("runOnce() passes callSite: 'filingAgent' to processMessage", async () => {
    const service = createService();
    await service.runOnce();

    expect(processMessageCalls).toHaveLength(1);
    expect(processMessageCalls[0].options).toEqual({ callSite: "filingAgent" });
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

  test("creates background conversation with generating title placeholder", async () => {
    const service = createService();
    await service.runOnce();

    expect(createdConversations).toHaveLength(1);
    expect(createdConversations[0].title).toBe("Generating title...");
    expect(createdConversations[0].conversationType).toBe("background");
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

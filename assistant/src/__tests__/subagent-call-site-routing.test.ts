/**
 * Regression test for the subagent provider routing fix.
 *
 * Before the fix, `SubagentManager.spawn()` constructed the Conversation with
 * `getProvider(appConfig.llm.default.provider)` directly, which meant per-call
 * `llm.callSites.subagentSpawn.provider` overrides only changed the request
 * *metadata* the downstream client saw — the actual HTTP transport still
 * belonged to `llm.default.provider`. After the fix, the provider is wrapped
 * in `CallSiteRoutingProvider`, which consults the resolver per call and
 * routes to the resolved provider's transport when it differs from the
 * default.
 *
 * This test stubs the `Conversation` constructor and the provider registry
 * so we can capture the provider that `SubagentManager` passes into
 * `Conversation`, then verify it's a `CallSiteRoutingProvider` that selects
 * the right transport for the `subagentSpawn` callSite.
 */
import { describe, expect, mock, test } from "bun:test";

import type { ServerMessage } from "../daemon/message-protocol.js";

// Capture the provider passed to Conversation.
let capturedProvider: unknown = undefined;
interface CapturedConversationState {
  trustContext: unknown;
  authContext: unknown;
  assistantId: string | undefined;
}

const capturedConversations: CapturedConversationState[] = [];

// Stub Conversation so spawn() doesn't try to actually run an agent loop —
// we only care about what provider it was constructed with.
class FakeConversation {
  private readonly capturedState: CapturedConversationState;

  constructor(
    _id: string,
    provider: unknown,
    _systemPrompt: string,
    _maxTokens: number,
    _sendToClient: (msg: ServerMessage) => void,
  ) {
    capturedProvider = provider;
    this.capturedState = {
      trustContext: undefined,
      authContext: undefined,
      assistantId: undefined,
    };
    capturedConversations.push(this.capturedState);
  }
  updateClient() {}
  setIsSubagent() {}
  setTrustContext(ctx: unknown) {
    this.capturedState.trustContext = ctx ?? undefined;
  }
  setAuthContext(ctx: unknown) {
    this.capturedState.authContext = ctx ?? undefined;
  }
  getAuthContext() {
    return this.capturedState.authContext;
  }
  setAssistantId(assistantId: string | null) {
    this.capturedState.assistantId = assistantId ?? undefined;
  }
  hasSystemPromptOverride = false;
  setSubagentAllowedTools() {}
  setPreactivatedSkillIds() {}
  preactivateSkills() {}
  preactivateSkillsAsync() {}
  setSpawnHints() {}
  injectInheritedContext() {}
  setActiveBranchId() {}
  setBranchTag() {}
  setForkPolicy() {}
  setForkParentMessageCount() {}
  setForkParentSystemPrompt() {}
  enqueueMessage() {
    return { rejected: false, queued: true };
  }
  abort() {}
  dispose() {}
  messages = [];
  usageStats = { inputTokens: 0, outputTokens: 0, estimatedCost: 0 };
  sendToClient() {}
  loadFromDb() {
    return Promise.resolve();
  }
  persistUserMessage() {
    return "msg-id";
  }
  runAgentLoop() {
    return Promise.resolve();
  }
  getCurrentSystemPrompt() {
    return "system";
  }
}

mock.module("../daemon/conversation.js", () => ({
  Conversation: FakeConversation,
}));

mock.module("../memory/conversation-bootstrap.js", () => ({
  bootstrapConversation: () => ({ id: "conv-id" }),
}));

mock.module("../prompts/system-prompt.js", () => ({
  buildSystemPrompt: () => "system prompt",
  buildSubagentSystemPrompt: () => "subagent system",
}));

// Provider registry — return distinct stubs so we can verify the selection.
const anthropicStub = { name: "anthropic" };
const openaiStub = { name: "openai" };

mock.module("../providers/registry.js", () => ({
  getProvider: (name: string) => {
    if (name === "anthropic") return anthropicStub;
    if (name === "openai") return openaiStub;
    throw new Error(`unknown provider: ${name}`);
  },
}));

// Mutable LLM config — tests rewrite this per-case.
let mockLlmConfig: Record<string, unknown> = {};

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    llm: mockLlmConfig,
    rateLimit: { maxRequestsPerMinute: 0 },
  }),
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

// ── Imports (after mocks) ───────────────────────────────────────────────────

import { LLMSchema } from "../config/schemas/llm.js";
import {
  clearConversations,
  setConversation,
} from "../daemon/conversation-store.js";
import { CallSiteRoutingProvider } from "../providers/call-site-routing.js";
import { SubagentManager } from "../subagent/manager.js";

function setLlmConfig(raw: unknown): void {
  mockLlmConfig = LLMSchema.parse(raw) as Record<string, unknown>;
}

describe("SubagentManager — provider call-site routing", () => {
  test("wraps the default provider in CallSiteRoutingProvider", async () => {
    setLlmConfig({
      default: { provider: "anthropic", model: "claude-opus-4-7" },
    });

    capturedProvider = undefined;
    const manager = new SubagentManager();
    await manager.spawn(
      {
        parentConversationId: "parent-1",
        label: "test",
        objective: "test objective",
      },
      () => {},
    );

    expect(capturedProvider).toBeInstanceOf(CallSiteRoutingProvider);
  });

  test("the wrapped provider exposes the default provider's name (stable identity for outer wrappers)", async () => {
    setLlmConfig({
      default: { provider: "anthropic", model: "claude-opus-4-7" },
      callSites: {
        subagentSpawn: { provider: "openai", model: "gpt-5.4" },
      },
    });

    capturedProvider = undefined;
    const manager = new SubagentManager();
    await manager.spawn(
      {
        parentConversationId: "parent-2",
        label: "test",
        objective: "test objective",
      },
      () => {},
    );

    // The wrapper exposes the *default* provider's name (so wrappers further
    // out — e.g. RateLimitProvider — see a stable identity), but routes the
    // actual sendMessage to the resolved provider. The routing behavior
    // itself is exercised in the next describe block with a fully-stubbed
    // provider pair.
    expect(capturedProvider).toBeInstanceOf(CallSiteRoutingProvider);
    const wrapper = capturedProvider as CallSiteRoutingProvider;
    expect(wrapper.name).toBe("anthropic");
  });

  test("falls back to default provider when subagentSpawn callSite is absent", async () => {
    setLlmConfig({
      default: { provider: "anthropic", model: "claude-opus-4-7" },
      // No subagentSpawn override.
    });

    capturedProvider = undefined;
    const manager = new SubagentManager();
    await manager.spawn(
      {
        parentConversationId: "parent-3",
        label: "test",
        objective: "test objective",
      },
      () => {},
    );

    expect(capturedProvider).toBeInstanceOf(CallSiteRoutingProvider);
    // Default provider's name surfaces.
    expect((capturedProvider as { name: string }).name).toBe("anthropic");
  });

  test("copies parent guardian and auth context into spawned conversation", async () => {
    setLlmConfig({
      default: { provider: "anthropic", model: "claude-opus-4-7" },
    });

    const parentTrustContext = {
      sourceChannel: "vellum",
      trustClass: "guardian",
      guardianPrincipalId: "guardian-1",
      guardianExternalUserId: "guardian-1",
    };
    const parentAuthContext = {
      subject: "local:self:parent-perms",
      actorPrincipalId: "guardian-1",
    };

    capturedConversations.length = 0;
    clearConversations();
    const manager = new SubagentManager();
    setConversation("parent-perms", {
      trustContext: parentTrustContext,
      getAuthContext: () => parentAuthContext,
      assistantId: "self",
      getCurrentSystemPrompt: () => "parent system",
    } as any);

    await manager.spawn(
      {
        parentConversationId: "parent-perms",
        label: "permissions",
        objective: "use web_fetch",
      },
      () => {},
    );

    const createdConversation = capturedConversations[0];
    expect(createdConversation).toBeDefined();
    if (!createdConversation) {
      throw new Error("Expected subagent conversation to be constructed");
    }
    expect(createdConversation.trustContext).toEqual(parentTrustContext);
    expect(createdConversation.authContext).toEqual(parentAuthContext);
    expect(createdConversation.assistantId).toBe("self");
    expect(createdConversation.trustContext).not.toBe(parentTrustContext);
    expect(createdConversation.authContext).not.toBe(parentAuthContext);
  });
});

// ── Direct unit test for CallSiteRoutingProvider's selection logic ─────────

describe("CallSiteRoutingProvider — selectProvider behavior", () => {
  test("routes to the resolved provider when callSite.provider differs from default", async () => {
    setLlmConfig({
      default: { provider: "anthropic", model: "claude-opus-4-7" },
      callSites: {
        subagentSpawn: { provider: "openai", model: "gpt-5.4" },
      },
    });

    let calledOnDefault = false;
    let calledOnAlternative = false;

    const defaultProvider = {
      name: "anthropic",
      sendMessage: async () => {
        calledOnDefault = true;
        return {
          content: [],
          model: "anthropic",
          usage: { inputTokens: 0, outputTokens: 0 },
          stopReason: "end_turn" as const,
        };
      },
    };
    const altProvider = {
      name: "openai",
      sendMessage: async () => {
        calledOnAlternative = true;
        return {
          content: [],
          model: "openai",
          usage: { inputTokens: 0, outputTokens: 0 },
          stopReason: "end_turn" as const,
        };
      },
    };

    const wrapper = new CallSiteRoutingProvider(defaultProvider, (name) => {
      if (name === "openai") return altProvider;
      return undefined;
    });

    await wrapper.sendMessage([], undefined, undefined, {
      config: { callSite: "subagentSpawn" },
    });

    expect(calledOnAlternative).toBe(true);
    expect(calledOnDefault).toBe(false);
  });

  test("routes to default when no callSite provided", async () => {
    setLlmConfig({
      default: { provider: "anthropic", model: "claude-opus-4-7" },
      callSites: {
        subagentSpawn: { provider: "openai", model: "gpt-5.4" },
      },
    });

    let calledOnDefault = false;

    const defaultProvider = {
      name: "anthropic",
      sendMessage: async () => {
        calledOnDefault = true;
        return {
          content: [],
          model: "anthropic",
          usage: { inputTokens: 0, outputTokens: 0 },
          stopReason: "end_turn" as const,
        };
      },
    };

    const wrapper = new CallSiteRoutingProvider(
      defaultProvider,
      () => undefined,
    );

    await wrapper.sendMessage([], undefined, undefined, {
      config: {},
    });

    expect(calledOnDefault).toBe(true);
  });
});

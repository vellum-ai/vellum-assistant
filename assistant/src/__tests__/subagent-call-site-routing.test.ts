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
  enabledPlugins: string[] | null | undefined;
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
      enabledPlugins: undefined,
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
  setEnabledPlugins(plugins: string[] | null) {
    this.capturedState.enabledPlugins = plugins;
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
    return { id: "msg-id", deduplicated: false };
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

mock.module("../persistence/conversation-bootstrap.js", () => ({
  bootstrapConversation: () => ({ id: "conv-id" }),
}));

mock.module("../prompts/system-prompt.js", () => ({
  buildSystemPrompt: () => "system prompt",
  buildSubagentSystemPrompt: () => "subagent system",
}));

// Provider registry + connection resolver — routing goes through
// `provider_connection` exclusively. `getProvider` is kept here purely
// because the registry module still exports it; the production code under
// test does not call it.
const anthropicStub = { name: "anthropic" };
const openaiStub = { name: "openai" };

mock.module("../providers/registry.js", () => ({
  getProvider: (name: string) => {
    throw new Error(`legacy getProvider should not be called: ${name}`);
  },
  resolveProviderFromConnection: async (connection: { name: string }) => {
    if (connection.name === "anthropic-conn") return anthropicStub;
    if (connection.name === "openai-conn") return openaiStub;
    return null;
  },
  clearConnectionProviderCache: () => {},
}));

// Connection lookup — feeds `resolveProviderFromConnection` above. The DB
// is stubbed; tests don't touch SQLite.
mock.module("../providers/inference/connections.js", () => ({
  getConnection: (_db: unknown, name: string) => {
    if (name === "anthropic-conn")
      return {
        name: "anthropic-conn",
        provider: "anthropic",
        auth: { type: "platform" },
      };
    if (name === "openai-conn")
      return {
        name: "openai-conn",
        provider: "openai",
        auth: { type: "platform" },
      };
    return null;
  },
}));

mock.module("../persistence/db-connection.js", () => ({
  getDb: () => ({}),
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
} from "../daemon/conversation-registry.js";
import { CallSiteRoutingProvider } from "../providers/call-site-routing.js";
import { SubagentManager } from "../subagent/manager.js";

function setLlmConfig(raw: unknown): void {
  mockLlmConfig = LLMSchema.parse(raw) as Record<string, unknown>;
}

describe("SubagentManager — provider call-site routing", () => {
  test("wraps the default provider in CallSiteRoutingProvider", async () => {
    setLlmConfig({
      default: {
        provider: "anthropic",
        provider_connection: "anthropic-conn",
        model: "claude-opus-4-7",
      },
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
    // Note: `provider_connection` lives on `ProfileEntry` and `LLMConfigBase`,
    // NOT on `LLMCallSiteConfig` (which is `LLMConfigFragment.extend({
    // profile })`). Setting `provider_connection` directly on a `callSites.*`
    // entry would be silently stripped by Zod. The correct shape for an
    // alternate-provider call-site override is a profile reference, defined
    // here as `altOpenai`.
    setLlmConfig({
      default: {
        provider: "anthropic",
        provider_connection: "anthropic-conn",
        model: "claude-opus-4-7",
      },
      profiles: {
        altOpenai: {
          provider: "openai",
          provider_connection: "openai-conn",
          model: "gpt-5.4",
        },
      },
      callSites: {
        subagentSpawn: { profile: "altOpenai" },
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
      default: {
        provider: "anthropic",
        provider_connection: "anthropic-conn",
        model: "claude-opus-4-7",
      },
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
      default: {
        provider: "anthropic",
        provider_connection: "anthropic-conn",
        model: "claude-opus-4-7",
      },
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

  test("copies the parent's plugin scope into the spawned conversation (by value)", async () => {
    setLlmConfig({
      default: {
        provider: "anthropic",
        provider_connection: "anthropic-conn",
        model: "claude-opus-4-7",
      },
    });

    const parentScope = ["caveman", "data"];

    capturedConversations.length = 0;
    clearConversations();
    const manager = new SubagentManager();
    setConversation("parent-scoped", {
      enabledPlugins: parentScope,
      getAuthContext: () => undefined,
      getCurrentSystemPrompt: () => "parent system",
    } as any);

    await manager.spawn(
      {
        parentConversationId: "parent-scoped",
        label: "scoped",
        objective: "use a plugin skill",
      },
      () => {},
    );

    const createdConversation = capturedConversations[0];
    // The subagent inherits the parent chat's plugin scope so it can't reach
    // plugins the user deselected in the parent.
    expect(createdConversation?.enabledPlugins).toEqual(["caveman", "data"]);
    // Copied by value so later parent/child edits don't alias one another.
    expect(createdConversation?.enabledPlugins).not.toBe(parentScope);
  });

  test("propagates a null (unrestricted) parent scope unchanged", async () => {
    setLlmConfig({
      default: {
        provider: "anthropic",
        provider_connection: "anthropic-conn",
        model: "claude-opus-4-7",
      },
    });

    capturedConversations.length = 0;
    clearConversations();
    const manager = new SubagentManager();
    setConversation("parent-unscoped", {
      enabledPlugins: null,
      getAuthContext: () => undefined,
      getCurrentSystemPrompt: () => "parent system",
    } as any);

    await manager.spawn(
      {
        parentConversationId: "parent-unscoped",
        label: "unscoped",
        objective: "use anything",
      },
      () => {},
    );

    expect(capturedConversations[0]?.enabledPlugins).toBeNull();
  });
});

// ── Direct unit test for CallSiteRoutingProvider's selection logic ─────────

describe("CallSiteRoutingProvider — selectProvider behavior", () => {
  test("routes to the resolved provider when callSite resolves to a profile with provider_connection", async () => {
    setLlmConfig({
      default: { provider: "anthropic", model: "claude-opus-4-7" },
      profiles: {
        altOpenai: {
          provider: "openai",
          provider_connection: "openai-conn",
          model: "gpt-5.4",
        },
      },
      callSites: {
        subagentSpawn: { profile: "altOpenai" },
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

    const wrapper = new CallSiteRoutingProvider(
      defaultProvider,
      async (connectionName) => {
        if (connectionName === "openai-conn") return altProvider;
        return null;
      },
    );

    await wrapper.sendMessage([], {
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
      async () => null,
    );

    await wrapper.sendMessage([], {
      config: {},
    });

    expect(calledOnDefault).toBe(true);
  });
});

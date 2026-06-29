/**
 * Tests for decoupling message-inheritance from prompt source and role on
 * context-inheriting subagents (forks).
 *
 * A fork normally pins the parent's system prompt verbatim and keeps the
 * `general` role so its KV cache stays aligned with the parent. These tests
 * verify the opt-out paths: a fork may supply its own `systemPromptOverride`
 * (which is used as-is and does NOT set `hasSystemPromptOverride`), and a fork
 * may carry an explicit read-only role (whose tool allowlist is applied). A
 * plain fork (no override, no role) must still behave exactly as before.
 *
 * The harness stubs `Conversation` and the spawn() dependencies so we can call
 * `SubagentManager.spawn()` directly and capture the constructed conversation's
 * system prompt, `hasSystemPromptOverride` flag, and allowed-tools set.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { ServerMessage } from "../daemon/message-protocol.js";

// ── Captured constructor state ──────────────────────────────────────────────

interface CapturedConversationState {
  systemPrompt: string;
  hasSystemPromptOverride: boolean;
  allowedTools: Set<string> | undefined;
}

const capturedConversations: CapturedConversationState[] = [];

// Stub Conversation so spawn() never runs an agent loop — we only inspect how
// it was constructed and configured.
class FakeConversation {
  private readonly captured: CapturedConversationState;

  constructor(
    _id: string,
    _provider: unknown,
    systemPrompt: string,
    _sendToClient: (msg: ServerMessage) => void,
    _workingDir: string,
    _options?: unknown,
  ) {
    this.captured = {
      systemPrompt,
      hasSystemPromptOverride: false,
      allowedTools: undefined,
    };
    capturedConversations.push(this.captured);
  }
  set hasSystemPromptOverride(value: boolean) {
    this.captured.hasSystemPromptOverride = value;
  }
  get hasSystemPromptOverride(): boolean {
    return this.captured.hasSystemPromptOverride;
  }
  conversationType = "background";
  updateClient() {}
  setIsSubagent() {}
  setTrustContext() {}
  setAuthContext() {}
  getAuthContext() {
    return undefined;
  }
  setAssistantId() {}
  setSubagentAllowedTools(tools: Set<string>) {
    this.captured.allowedTools = tools;
  }
  setPreactivatedSkillIds() {}
  injectInheritedContext() {}
  abort() {}
  dispose() {}
  messages = [];
  usageStats = { inputTokens: 0, outputTokens: 0, estimatedCost: 0 };
  sendToClient() {}
  persistUserMessage() {
    return { id: "msg-id", deduplicated: false };
  }
  runAgentLoop() {
    return Promise.resolve();
  }
  getCurrentSystemPrompt() {
    return "resolved-parent-prompt";
  }
}

mock.module("../daemon/conversation.js", () => ({
  Conversation: FakeConversation,
}));

mock.module("../persistence/conversation-bootstrap.js", () => ({
  bootstrapConversation: () => ({ id: "conv-id" }),
}));

// Resolve a stub provider without touching connections/DB.
const providerStub = { name: "anthropic", sendMessage: async () => ({}) };

mock.module("../providers/connection-resolution.js", () => ({
  resolveDefaultProvider: async () => providerStub,
}));

mock.module("../providers/call-site-routing.js", () => ({
  wrapWithCallSiteRouting: (p: unknown) => p,
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    llm: { default: { provider: "anthropic", model: "claude-opus-4-7" } },
    rateLimit: { maxRequestsPerMinute: 0 },
  }),
}));

mock.module("../config/llm-resolver.js", () => ({
  resolveCallSiteConfig: () => ({ provider: "anthropic", maxTokens: 8192 }),
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

// ── Imports (after mocks) ───────────────────────────────────────────────────

import { clearConversations } from "../daemon/conversation-registry.js";
import { SubagentManager } from "../subagent/manager.js";
import type { SubagentConfig } from "../subagent/types.js";

const PARENT_PROMPT = "You are the parent's system prompt.";

type SpawnConfig = Omit<SubagentConfig, "id">;

function makeForkSpawnConfig(
  overrides: Partial<SpawnConfig> = {},
): SpawnConfig {
  return {
    parentConversationId: `parent-${Math.random().toString(36).slice(2)}`,
    label: "test fork",
    objective: "do something",
    fork: true,
    parentSystemPrompt: PARENT_PROMPT,
    ...overrides,
  };
}

describe("SubagentManager fork — prompt source and role decoupling", () => {
  let manager: SubagentManager;

  beforeEach(() => {
    clearConversations();
    capturedConversations.length = 0;
    manager = new SubagentManager();
  });

  afterEach(() => {
    (manager as unknown as { stopSweep: () => void }).stopSweep();
  });

  /** Spawn a fork and return the single conversation that spawn() constructed. */
  async function spawnFork(
    overrides: Partial<SpawnConfig> = {},
  ): Promise<CapturedConversationState> {
    await manager.spawn(makeForkSpawnConfig(overrides), () => {});
    const created = capturedConversations[0];
    if (!created) throw new Error("Expected a subagent conversation");
    return created;
  }

  test("fork with systemPromptOverride uses that prompt and does not set hasSystemPromptOverride", async () => {
    const overridePrompt = "You are an advisor. Frame the context as advice.";
    const created = await spawnFork({ systemPromptOverride: overridePrompt });

    expect(created.systemPrompt).toBe(overridePrompt);
    expect(created.hasSystemPromptOverride).toBe(false);
  });

  test("fork with explicit read-only role applies the role allowlist via setSubagentAllowedTools", async () => {
    const created = await spawnFork({ role: "researcher" });

    // The researcher role is read-only; its allowlist must be applied even for
    // a fork.
    expect(created.allowedTools).toBeInstanceOf(Set);
    expect(created.allowedTools?.has("web_search")).toBe(true);
    expect(created.allowedTools?.has("file_read")).toBe(true);
    expect(created.allowedTools?.has("bash")).toBe(false);
  });

  test("plain fork (no override, no role) keeps parent prompt verbatim, general tools, and sets hasSystemPromptOverride", async () => {
    const created = await spawnFork();

    // Parent prompt verbatim, no tool filter (general role has no allowlist),
    // and the prompt is pinned for KV-cache alignment.
    expect(created.systemPrompt).toBe(PARENT_PROMPT);
    expect(created.allowedTools).toBeUndefined();
    expect(created.hasSystemPromptOverride).toBe(true);
  });
});

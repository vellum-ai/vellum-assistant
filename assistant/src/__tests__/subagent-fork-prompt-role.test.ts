/**
 * Tests for decoupling message-inheritance from prompt source and role on
 * context-inheriting subagents (forks).
 *
 * A fork normally pins the parent's system prompt verbatim and runs on the
 * default role, whose unrestricted surface matches the prompt it inherits, so
 * its KV cache stays aligned with the parent. These tests verify the opt-out
 * paths: a fork may supply its own `systemPromptOverride` (which is used as-is
 * and does NOT set `hasSystemPromptOverride`), and a fork may carry an explicit
 * read-only role (whose tool allowlist is applied). A plain fork (no override,
 * no role) keeps the parent's whole tool surface.
 *
 * A fork's persona is covered here too: the inherited prompt leaves
 * `buildSubagentSystemPrompt` unused, so the persona reaches the child through
 * its first message instead.
 *
 * The harness stubs `Conversation` and the spawn() dependencies so we can call
 * `SubagentManager.spawn()` directly and capture the constructed conversation's
 * system prompt, `hasSystemPromptOverride` flag, allowed-tools set, and first
 * user message.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { AssistantEvent } from "../api/index.js";

// ── Captured constructor state ──────────────────────────────────────────────

interface CapturedConversationState {
  systemPrompt: string;
  hasSystemPromptOverride: boolean;
  allowedTools: Set<string> | undefined;
  /** Content of every user message the run persisted, in order. */
  userMessages: string[];
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
    _sendToClient: (msg: AssistantEvent) => void,
    _workingDir: string,
    _options?: unknown,
  ) {
    this.captured = {
      systemPrompt,
      hasSystemPromptOverride: false,
      allowedTools: undefined,
      userMessages: [],
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
  persistUserMessage(args: { content: string }) {
    this.captured.userMessages.push(args.content);
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

mock.module("../config/llm-resolver.js", () => ({
  resolveCallSiteConfig: () => ({ provider: "anthropic", maxTokens: 8192 }),
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
    if (!created) {
      throw new Error("Expected a subagent conversation");
    }
    return created;
  }

  /**
   * The first user message the run persisted. `spawn` fires the run without
   * awaiting it, so the message lands a few ticks after spawn resolves.
   */
  async function firstUserMessage(
    created: CapturedConversationState,
  ): Promise<string> {
    for (let attempt = 0; attempt < 50; attempt++) {
      const first = created.userMessages[0];
      if (first !== undefined) {
        return first;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Expected the subagent run to persist a user message");
  }

  test("fork with systemPromptOverride uses that prompt and does not set hasSystemPromptOverride", async () => {
    const overridePrompt = "You are a reviewer. Frame the context as review.";
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

  test("plain fork (no override, no role) keeps parent prompt verbatim, the parent's whole tool surface, and sets hasSystemPromptOverride", async () => {
    const created = await spawnFork();

    // Parent prompt verbatim, no tool filter (the default role declares no
    // allowlist), and the prompt is pinned for KV-cache alignment.
    expect(created.systemPrompt).toBe(PARENT_PROMPT);
    expect(created.allowedTools).toBeUndefined();
    expect(created.hasSystemPromptOverride).toBe(true);
  });

  test("a fork's persona reaches the child in its first message", async () => {
    const created = await spawnFork({
      role: "researcher",
      persona: "financial journalist",
    });
    const first = await firstUserMessage(created);

    // The system prompt is the parent's, so the message is the only carrier.
    expect(created.systemPrompt).toBe(PARENT_PROMPT);
    expect(created.systemPrompt).not.toContain("financial journalist");
    expect(first).toContain("Act as financial journalist for this task.");
    expect(first).toContain("do something");
  });

  test("a fork with no persona gets no persona line", async () => {
    const created = await spawnFork();
    const first = await firstUserMessage(created);

    expect(first).toContain("FORK TASK");
    expect(first).not.toContain("Act as");
  });

  test("a fork's output contract reaches the child in its first message", async () => {
    const created = await spawnFork({
      role: "researcher",
      outputContract: "verdict",
    });
    const first = await firstUserMessage(created);

    // Same carrier as the persona, and for the same reason: the system prompt
    // is the parent's, so nothing the contract says can land there.
    expect(created.systemPrompt).toBe(PARENT_PROMPT);
    expect(created.systemPrompt).not.toContain("PASS or FAIL");
    expect(first).toContain(
      "Output contract: For each criterion in the objective return PASS or FAIL",
    );
    expect(first).toContain("do something");
  });

  test("a fork under the default report contract gets no contract line", async () => {
    const created = await spawnFork({ outputContract: "report" });
    const first = await firstUserMessage(created);

    expect(first).toContain("FORK TASK");
    expect(first).not.toContain("Output contract:");
  });
});

/**
 * Verifies that the per-turn `overrideProfile` plumbed into `AgentLoop.run()`
 * surfaces on every `SendMessageOptions.config` the loop emits, and that
 * `SubagentManager.spawn()` propagates an inherited `overrideProfile` from
 * its `SubagentConfig` into the subagent's `runAgentLoop()` call.
 *
 * Together these two assertions establish the PR 6 contract: a parent
 * conversation that pins an inference profile sees that profile applied to
 * every LLM call within its agent-loop turn, and any subagent spawned during
 * that turn inherits the same profile automatically.
 *
 * Default behavior (no `overrideProfile` set) must remain unchanged — the
 * field is omitted from `providerConfig` rather than carrying `undefined`.
 */

import { describe, expect, mock, test } from "bun:test";

import { makeMockLogger } from "./helpers/mock-logger.js";

mock.module("../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

import { AgentLoop } from "../agent/loop.js";
import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
  ToolDefinition,
} from "../providers/types.js";

const userMessage: Message = {
  role: "user",
  content: [{ type: "text", text: "hi" }],
};

function textResponse(text: string): ProviderResponse {
  return {
    content: [{ type: "text", text }],
    model: "mock-model",
    usage: { inputTokens: 1, outputTokens: 1 },
    stopReason: "end_turn",
  };
}

function toolUseResponse(
  id: string,
  name: string,
  input: Record<string, unknown>,
): ProviderResponse {
  return {
    content: [{ type: "tool_use", id, name, input }],
    model: "mock-model",
    usage: { inputTokens: 1, outputTokens: 1 },
    stopReason: "tool_use",
  };
}

/**
 * Build a provider that records every `SendMessageOptions.config` it sees so
 * the test can assert how the agent loop populated `overrideProfile` on each
 * iteration of the multi-turn tool loop.
 */
function makeRecordingProvider(responses: ProviderResponse[]): {
  provider: Provider;
  configs: () => Array<Record<string, unknown> | undefined>;
} {
  const configs: Array<Record<string, unknown> | undefined> = [];
  let i = 0;
  const provider: Provider = {
    name: "mock",
    async sendMessage(
      _messages: Message[],
      _tools?: ToolDefinition[],
      _systemPrompt?: string,
      options?: SendMessageOptions,
    ): Promise<ProviderResponse> {
      configs.push(options?.config as Record<string, unknown> | undefined);
      const response = responses[i] ?? responses[responses.length - 1];
      i++;
      return response;
    },
  };
  return { provider, configs: () => configs };
}

describe("AgentLoop.run — overrideProfile plumbing", () => {
  test("forwards overrideProfile to providerConfig on every LLM call (multi-turn)", async () => {
    // Two tool-use turns followed by a final text response so the loop
    // performs three provider sends. Every send must carry the same
    // overrideProfile that was passed into `run()`.
    const { provider, configs } = makeRecordingProvider([
      toolUseResponse("t1", "echo", { value: "first" }),
      toolUseResponse("t2", "echo", { value: "second" }),
      textResponse("done"),
    ]);

    const dummyTools: ToolDefinition[] = [
      {
        name: "echo",
        description: "Echo back the input",
        input_schema: {
          type: "object",
          properties: { value: { type: "string" } },
        },
      },
    ];

    const toolExecutor = async (
      _name: string,
      _input: Record<string, unknown>,
    ) => ({ content: "ok", isError: false });

    const loop = new AgentLoop(
      provider,
      "system",
      { maxTokens: 1024 },
      dummyTools,
      toolExecutor,
    );

    await loop.run(
      [userMessage],
      () => {},
      undefined, // signal
      undefined, // requestId
      undefined, // onCheckpoint
      "mainAgent", // callSite
      undefined, // turnContext
      "fast", // overrideProfile
    );

    // Three sends — initial + two tool round-trips.
    expect(configs()).toHaveLength(3);
    for (const cfg of configs()) {
      expect(cfg?.overrideProfile).toBe("fast");
    }
  });

  test("omits overrideProfile from providerConfig when unset (default behavior unchanged)", async () => {
    const { provider, configs } = makeRecordingProvider([textResponse("hi")]);
    const loop = new AgentLoop(provider, "system", { maxTokens: 1024 });

    await loop.run([userMessage], () => {});

    // Single send, no overrideProfile field at all.
    expect(configs()).toHaveLength(1);
    expect(configs()[0]).toBeDefined();
    expect("overrideProfile" in (configs()[0] ?? {})).toBe(false);
  });

  test("missing overrideProfile name still flows through (silent fall-through is the resolver's job)", async () => {
    // The agent loop must NOT validate the profile name — that's the
    // resolver's responsibility. The loop forwards whatever string it
    // receives so a non-existent profile silently falls back at the
    // provider layer (covered by provider-send-message-override-profile.test.ts).
    const { provider, configs } = makeRecordingProvider([textResponse("hi")]);
    const loop = new AgentLoop(provider, "system", { maxTokens: 1024 });

    await loop.run(
      [userMessage],
      () => {},
      undefined,
      undefined,
      undefined,
      "mainAgent",
      undefined,
      "does-not-exist",
    );

    expect(configs()[0]?.overrideProfile).toBe("does-not-exist");
  });
});

// ── Subagent inheritance ─────────────────────────────────────────────────

// Capture the SubagentManager → Conversation handshake so we can verify the
// `overrideProfile` from `SubagentConfig` is forwarded into the spawned
// subagent's `runAgentLoop()` invocation. Same pattern as
// `subagent-call-site-routing.test.ts`.
interface CapturedRunAgentLoopOptions {
  isInteractive?: boolean;
  isUserMessage?: boolean;
  titleText?: string;
  callSite?: string;
  overrideProfile?: string;
}

const capturedRunAgentLoopOptions: CapturedRunAgentLoopOptions[] = [];

class FakeConversation {
  constructor() {}
  updateClient() {}
  setIsSubagent() {}
  setTrustContext() {}
  setAuthContext() {}
  getAuthContext() {
    return undefined;
  }
  setAssistantId() {}
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
    return { rejected: false, queued: false };
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
    return Promise.resolve("msg-id");
  }
  runAgentLoop(
    _content: string,
    _userMessageId: string,
    _onEvent: unknown,
    options?: CapturedRunAgentLoopOptions,
  ) {
    capturedRunAgentLoopOptions.push({ ...(options ?? {}) });
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

const anthropicStub = { name: "anthropic" };

mock.module("../providers/registry.js", () => ({
  getProvider: () => anthropicStub,
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    llm: { default: { provider: "anthropic", model: "claude-opus-4-7" } },
    rateLimit: { maxRequestsPerMinute: 0 },
  }),
}));

import { SubagentManager } from "../subagent/manager.js";

describe("SubagentManager.spawn — overrideProfile inheritance", () => {
  test("forwards overrideProfile from SubagentConfig into runAgentLoop", async () => {
    capturedRunAgentLoopOptions.length = 0;

    const manager = new SubagentManager();
    await manager.spawn(
      {
        parentConversationId: "parent-1",
        label: "child",
        objective: "do the thing",
        overrideProfile: "fast",
      },
      () => {},
    );

    // The spawned subagent's runAgentLoop must receive both the
    // `subagentSpawn` callSite (existing behavior) and the inherited
    // `overrideProfile` (new behavior).
    expect(capturedRunAgentLoopOptions).toHaveLength(1);
    const captured = capturedRunAgentLoopOptions[0];
    expect(captured.callSite).toBe("subagentSpawn");
    expect(captured.overrideProfile).toBe("fast");
  });

  test("omits overrideProfile when SubagentConfig does not set it", async () => {
    capturedRunAgentLoopOptions.length = 0;

    const manager = new SubagentManager();
    await manager.spawn(
      {
        parentConversationId: "parent-2",
        label: "child",
        objective: "do the thing",
      },
      () => {},
    );

    expect(capturedRunAgentLoopOptions).toHaveLength(1);
    const captured = capturedRunAgentLoopOptions[0];
    expect(captured.callSite).toBe("subagentSpawn");
    // Field must be absent rather than carrying `undefined`, mirroring the
    // agent loop's "field omitted when unset" contract.
    expect("overrideProfile" in captured).toBe(false);
  });
});

// ── Nested subagent spawn — context.overrideProfile preferred ────────────

// Verify the third-level inheritance contract: when a subagent's agent loop
// is running with `currentTurnOverrideProfile`, the executor closure plumbs
// that value into `ToolContext.overrideProfile`. `executeSubagentSpawn` must
// then prefer `context.overrideProfile` over a row read against the in-flight
// subagent's own conversationId — that row never has `inferenceProfile` set,
// and `getConversationOverrideProfile` short-circuits for background
// conversations regardless. Without preferring the in-memory context, the
// inheritance chain breaks at the second nesting level.

mock.module("../memory/conversation-crud.js", () => ({
  // Always return undefined for the row read so the test fails fast unless
  // executeSubagentSpawn reads from context.overrideProfile first.
  getConversationOverrideProfile: () => undefined,
}));

import { getSubagentManager } from "../subagent/index.js";
import { executeSubagentSpawn } from "../tools/subagent/spawn.js";

describe("executeSubagentSpawn — nested inheritance via context.overrideProfile", () => {
  test("forwards context.overrideProfile to SubagentConfig (third-level inheritance)", async () => {
    const manager = getSubagentManager();
    const originalSpawn = manager.spawn.bind(manager);
    let capturedConfig: Record<string, unknown> | undefined;
    manager.spawn = async (config: Record<string, unknown>) => {
      capturedConfig = config;
      return "nested-subagent-id";
    };

    try {
      // Simulate the second-level spawn: tool invocation occurs inside the
      // first subagent's tool context, where `overrideProfile` was populated
      // by `runAgentLoopImpl` from its `currentTurnOverrideProfile` snapshot.
      // The first subagent's own conversation row has no `inferenceProfile`,
      // so the row-read fallback would otherwise return undefined.
      const result = await executeSubagentSpawn(
        { label: "nested", objective: "do nested work" },
        {
          workingDir: "/tmp",
          conversationId: "subagent-conv-id",
          trustClass: "guardian",
          sendToClient: () => {},
          overrideProfile: "fast",
        } as import("../tools/types.js").ToolContext,
      );

      expect(result.isError).toBe(false);
      expect(capturedConfig).toBeDefined();
      // The forwarded SubagentConfig must carry the in-memory override so
      // SubagentManager.spawn forwards it into the nested subagent's
      // runAgentLoop options — preserving inheritance across the chain.
      expect(capturedConfig!.overrideProfile).toBe("fast");
    } finally {
      manager.spawn = originalSpawn;
    }
  });

  test("omits overrideProfile when neither context nor row carries it", async () => {
    const manager = getSubagentManager();
    const originalSpawn = manager.spawn.bind(manager);
    let capturedConfig: Record<string, unknown> | undefined;
    manager.spawn = async (config: Record<string, unknown>) => {
      capturedConfig = config;
      return "nested-subagent-id-2";
    };

    try {
      await executeSubagentSpawn(
        { label: "nested", objective: "do nested work" },
        {
          workingDir: "/tmp",
          conversationId: "subagent-conv-id-2",
          trustClass: "guardian",
          sendToClient: () => {},
          // no overrideProfile
        } as import("../tools/types.js").ToolContext,
      );

      expect(capturedConfig).toBeDefined();
      // Field must be absent rather than carrying `undefined` so the
      // SubagentConfig respects the same "field omitted when unset"
      // contract the agent loop uses.
      expect("overrideProfile" in capturedConfig!).toBe(false);
    } finally {
      manager.spawn = originalSpawn;
    }
  });
});

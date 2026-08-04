/**
 * Verifies that the schedule firing's `cron_runs.id` reaches the LLM work a
 * scheduled turn delegates to subagents.
 *
 * A scheduled turn stamps every usage row it records with `cronRunId`, and
 * schedule cost reporting attributes by that stamp. A subagent runs as its own
 * child conversation, so unless the firing id is threaded through
 * `ToolContext` → `SubagentConfig` → the child's `runAgentLoop`, the delegated
 * spend records a null `cron_run_id` and drops out of the schedule's cost.
 *
 * The threading mirrors `overrideProfile`; the plumbing for that field is
 * pinned by `agent-loop-override-profile.test.ts`.
 */

import { describe, expect, mock, test } from "bun:test";

import type { ToolContext } from "../tools/types.js";
import { setConfig } from "./helpers/set-config.js";

interface CapturedRunAgentLoopOptions {
  callSite?: string;
  overrideProfile?: string;
  forceOverrideProfile?: boolean;
  cronRunId?: string | null;
}

const capturedRunAgentLoopOptions: CapturedRunAgentLoopOptions[] = [];

// When set, `runAgentLoop` never settles, so the spawned subagent stays in a
// non-terminal state and can accept a follow-up `sendMessage`.
let holdRunAgentLoop = false;

class FakeConversation {
  constructor() {}
  updateClient() {}

  setTrustContext() {}
  setAuthContext() {}
  getAuthContext() {
    return undefined;
  }
  setAssistantId() {}
  setEnabledPlugins() {}
  hasSystemPromptOverride = false;
  setSubagentAllowedTools() {}
  setSubagentDenySideEffects() {}
  setSubagentSuppressParentNotifications() {}
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
  subagentDeniedToolNames: string[] = [];
  usageStats = { inputTokens: 0, outputTokens: 0, estimatedCost: 0 };
  sendToClient() {}
  loadFromDb() {
    return Promise.resolve();
  }
  persistUserMessage() {
    return Promise.resolve({ id: "msg-id", deduplicated: false });
  }
  runAgentLoop(
    _content: string,
    _userMessageId: string,
    options?: CapturedRunAgentLoopOptions,
  ) {
    capturedRunAgentLoopOptions.push({ ...(options ?? {}) });
    if (holdRunAgentLoop) {
      return new Promise<void>(() => {});
    }
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

mock.module("../persistence/conversation-crud.js", () => ({
  setConversationProcessingStartedAt: () => {},
  getConversationOverrideProfile: () => undefined,
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
}));

const anthropicStub = { name: "anthropic" };

mock.module("../providers/registry.js", () => ({
  getProvider: () => anthropicStub,
  listProviders: () => ["anthropic"],
  initializeProviders: async () => {},
  resolveProviderFromConnection: async () => anthropicStub,
}));

mock.module("../providers/inference/connections.js", () => ({
  getConnection: (_db: unknown, name: string) => ({
    id: 1,
    name,
    provider: "anthropic",
    auth_strategy: "user_managed_credential",
    credential_alias: null,
    metadata_json: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }),
}));

setConfig("llm", {
  profiles: {
    fast: {
      source: "user",
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
    },
  },
  callSites: {},
});

// ── Imports (after mocks) ───────────────────────────────────────────────────

import { getSubagentManager } from "../subagent/index.js";
import { SubagentManager } from "../subagent/manager.js";
import { executeSubagentSpawn } from "../tools/subagent/spawn.js";

function toolContext(overrides: Partial<ToolContext>): ToolContext {
  return {
    workingDir: "/tmp",
    conversationId: "conv-scheduled",
    trustClass: "guardian",
    sendToClient: () => {},
    ...overrides,
  } as ToolContext;
}

describe("executeSubagentSpawn: cronRunId forwarding", () => {
  test("forwards the turn's cronRunId into the SubagentConfig", async () => {
    const manager = getSubagentManager();
    const originalSpawn = manager.spawn.bind(manager);
    let capturedConfig: Record<string, unknown> | undefined;
    manager.spawn = async (config: never) => {
      capturedConfig = config;
      return "subagent-cron-1";
    };

    try {
      const result = await executeSubagentSpawn(
        { label: "scheduled-child", objective: "do the delegated work" },
        toolContext({ cronRunId: "cron-run-abc" }),
      );

      expect(result.isError).toBe(false);
      expect(capturedConfig?.cronRunId).toBe("cron-run-abc");
    } finally {
      manager.spawn = originalSpawn;
    }
  });

  test("omits cronRunId when the invoking turn was not triggered by a schedule", async () => {
    const manager = getSubagentManager();
    const originalSpawn = manager.spawn.bind(manager);
    let capturedConfig: Record<string, unknown> | undefined;
    manager.spawn = async (config: never) => {
      capturedConfig = config;
      return "subagent-cron-2";
    };

    try {
      await executeSubagentSpawn(
        { label: "interactive-child", objective: "do the delegated work" },
        toolContext({ conversationId: "conv-interactive" }),
      );

      expect(capturedConfig).toBeDefined();
      expect("cronRunId" in capturedConfig!).toBe(false);
    } finally {
      manager.spawn = originalSpawn;
    }
  });
});

describe("SubagentManager: cronRunId reaches the child's agent loop", () => {
  test("passes the config's cronRunId into the spawned subagent's runAgentLoop", async () => {
    capturedRunAgentLoopOptions.length = 0;

    const manager = new SubagentManager();
    await manager.spawn(
      {
        parentConversationId: "parent-cron-1",
        label: "child",
        objective: "do the thing",
        cronRunId: "cron-run-abc",
      },
      () => {},
    );

    expect(capturedRunAgentLoopOptions).toHaveLength(1);
    const captured = capturedRunAgentLoopOptions[0]!;
    expect(captured.callSite).toBe("subagentSpawn");
    expect(captured.cronRunId).toBe("cron-run-abc");
  });

  test("omits cronRunId when the SubagentConfig does not carry one", async () => {
    capturedRunAgentLoopOptions.length = 0;

    const manager = new SubagentManager();
    await manager.spawn(
      {
        parentConversationId: "parent-cron-2",
        label: "child",
        objective: "do the thing",
      },
      () => {},
    );

    expect(capturedRunAgentLoopOptions).toHaveLength(1);
    expect("cronRunId" in capturedRunAgentLoopOptions[0]!).toBe(false);
  });

  test("a continuation turn carries the messaging turn's cronRunId, not the spawn's", async () => {
    capturedRunAgentLoopOptions.length = 0;
    holdRunAgentLoop = true;

    try {
      const manager = new SubagentManager();
      const subagentId = await manager.spawn(
        {
          parentConversationId: "parent-cron-3",
          label: "child",
          objective: "do the thing",
          cronRunId: "cron-run-spawn",
        },
        () => {},
      );
      // The initial run is fire-and-forget; let it reach runAgentLoop.
      await Promise.resolve();
      await Promise.resolve();

      const result = await manager.sendMessage(subagentId, "keep going", {
        cronRunId: "cron-run-message",
      });
      expect(result).toBe("sent");

      expect(capturedRunAgentLoopOptions).toHaveLength(2);
      expect(capturedRunAgentLoopOptions[0]!.cronRunId).toBe("cron-run-spawn");
      expect(capturedRunAgentLoopOptions[1]!.cronRunId).toBe(
        "cron-run-message",
      );
    } finally {
      holdRunAgentLoop = false;
    }
  });

  test("omits cronRunId on a continuation turn no schedule triggered", async () => {
    capturedRunAgentLoopOptions.length = 0;
    holdRunAgentLoop = true;

    try {
      const manager = new SubagentManager();
      const subagentId = await manager.spawn(
        {
          parentConversationId: "parent-cron-4",
          label: "child",
          objective: "do the thing",
          cronRunId: "cron-run-spawn",
        },
        () => {},
      );
      await Promise.resolve();
      await Promise.resolve();

      await manager.sendMessage(subagentId, "keep going", { cronRunId: null });

      expect(capturedRunAgentLoopOptions).toHaveLength(2);
      expect("cronRunId" in capturedRunAgentLoopOptions[1]!).toBe(false);
    } finally {
      holdRunAgentLoop = false;
    }
  });
});

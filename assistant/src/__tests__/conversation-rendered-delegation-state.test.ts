/**
 * `Conversation.buildCurrentSystemPrompt` captures the delegation-section
 * state the prompt it builds renders (`renderedDelegateIndependentTasks`),
 * which the wire-surface recorder persists for a retrospective fork to
 * replay. The loop sends the prompt built before the run and never rebuilds
 * it mid-run, so the captured state has to be the one that build used: not a
 * re-derivation at send time, and not the state of a build that failed while
 * the loop kept its previous prompt.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { CompactionCircuit } from "../agent/compaction-circuit.js";
import type { AgentEvent } from "../agent/loop.js";
import type { AssistantEvent } from "../api/index.js";
import type { Message, ProviderResponse } from "../providers/types.js";

// ---------------------------------------------------------------------------
// Mocks — must precede Conversation import
// ---------------------------------------------------------------------------

mock.module("../providers/registry.js", () => ({
  getProvider: () => ({ name: "mock-provider" }),
  initializeProviders: async () => {},
}));

mock.module("../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: () => true,
}));

// The builder under the conversation's control: records the options each
// build receives and can be made to throw, which is what a wake's prompt
// sync swallows before running on the previous prompt.
let builtWith: Array<Record<string, unknown> | undefined> = [];
let throwOnBuild = false;
mock.module("../prompts/system-prompt.js", () => ({
  buildSystemPrompt: (options?: Record<string, unknown>) => {
    if (throwOnBuild) {
      throw new Error("prompt build failed");
    }
    builtWith.push(options);
    return "system prompt";
  },
}));

mock.module("../config/skills.js", () => ({
  loadSkillCatalog: () => [],
  loadSkillBySelector: () => ({ skill: null }),
  ensureSkillIcon: async () => null,
}));

mock.module("../config/skill-state.js", () => ({
  resolveSkillStates: () => [],
}));

mock.module("../permissions/trust-store.js", () => ({
  addRule: () => {},
  findHighestPriorityRule: () => null,
  clearCache: () => {},
}));

mock.module("../security/secret-allowlist.js", () => ({
  resetAllowlist: () => {},
}));

mock.module("../persistence/conversation-crud.js", () => ({
  setConversationProcessingStartedAt: () => {},
  isConversationProcessing: () => false,
  setConversationOriginChannelIfUnset: () => {},
  updateConversationContextWindow: () => {},
  deleteMessageById: () => {},
  provenanceFromTrustContext: () => ({
    source: "user",
    trustContext: undefined,
  }),
  getConversationOriginInterface: () => null,
  getConversationOriginChannel: () => null,
  getMessages: () => [],
  getConversation: () => ({
    id: "conv-1",
    contextSummary: null,
    contextCompactedMessageCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalEstimatedCost: 0,
  }),
  createConversation: () => ({ id: "conv-1" }),
  addMessage: () => ({ id: `msg-${Date.now()}` }),
  updateConversationUsage: () => {},
  updateConversationTitle: () => {},
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
}));

mock.module("../persistence/conversation-queries.js", () => ({
  listConversations: () => [],
}));

mock.module("../persistence/attachments-store.js", () => ({
  uploadAttachment: () => ({ id: `att-${Date.now()}` }),
  linkAttachmentToMessage: () => {},
}));

mock.module("../plugins/defaults/compaction/window-manager.js", () => ({
  ContextWindowManager: class {
    estimateInputTokens() {
      return 0;
    }
    get tokenCountInputs() {
      return { systemPrompt: "", tools: undefined };
    }
    constructor() {}
    updateConfig() {}
    shouldCompact() {
      return { needed: false, estimatedTokens: 0 };
    }
    async maybeCompact() {
      return { compacted: false };
    }
    resetOverflowRecovery() {}
  },
  createContextSummaryMessage: () => ({
    role: "user",
    content: [{ type: "text", text: "summary" }],
  }),
  getSummaryFromContextMessage: () => null,
}));

mock.module("../persistence/llm-usage-store.js", () => ({
  recordUsageEvent: () => ({ id: "mock-id", createdAt: Date.now() }),
  listUsageEvents: () => [],
}));

mock.module("../agent/loop.js", () => ({
  AgentLoop: class {
    compactionCircuit = new CompactionCircuit("test-conv");
    constructor() {}
    getToolTokenBudget() {
      return 0;
    }
    getResolvedTools() {
      return [];
    }
    getActiveModel() {
      return undefined;
    }
    setSystemPrompt() {}
    async run(_options: {
      messages: Message[];
      onEvent: (event: AgentEvent) => void;
    }): Promise<Message[]> {
      return [];
    }
  },
}));

// ---------------------------------------------------------------------------
// Import Conversation AFTER mocks
// ---------------------------------------------------------------------------

import { Conversation } from "../daemon/conversation.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProvider() {
  return {
    name: "mock",
    async sendMessage(): Promise<ProviderResponse> {
      return {
        content: [],
        model: "mock",
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: "end_turn",
      };
    },
  };
}

let conversationSeq = 0;

/**
 * A conversation whose prompt is built, or, given a prompt other than the
 * builder's, one running on a verbatim system-prompt override.
 */
function makeConversation(systemPrompt = "system prompt"): Conversation {
  conversationSeq += 1;
  return new Conversation(
    `conv-rendered-delegation-${conversationSeq}`,
    makeProvider(),
    systemPrompt,
    (_msg: AssistantEvent) => {},
    "/tmp",
    { maxTokens: 4096 },
  );
}

function lastBuildDelegation(): unknown {
  return builtWith.at(-1)?.delegateIndependentTasks;
}

beforeEach(() => {
  builtWith = [];
  throwOnBuild = false;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Conversation.buildCurrentSystemPrompt delegation-state capture", () => {
  test("captures the state the build rendered and hands the builder the same value", () => {
    const conversation = makeConversation();
    expect(conversation.renderedDelegateIndependentTasks).toBeUndefined();

    conversation.buildCurrentSystemPrompt();

    // An unrestricted turn can spawn, so the section renders on.
    expect(conversation.renderedDelegateIndependentTasks).toBe(true);
    expect(lastBuildDelegation()).toBe(true);
  });

  test("a change to the gate's inputs after the build does not touch the captured state until the next build", () => {
    const conversation = makeConversation();
    conversation.buildCurrentSystemPrompt();
    expect(conversation.renderedDelegateIndependentTasks).toBe(true);

    // The loop is still sending the prompt built above, so the recorder must
    // see that prompt's state, whatever the gate would derive now.
    conversation.setSubagentAllowedTools(new Set(["remember"]));
    expect(conversation.renderedDelegateIndependentTasks).toBe(true);

    conversation.buildCurrentSystemPrompt();
    expect(conversation.renderedDelegateIndependentTasks).toBe(false);
    expect(lastBuildDelegation()).toBe(false);
  });

  test("a failed build leaves the previously captured state in place", () => {
    const conversation = makeConversation();
    conversation.buildCurrentSystemPrompt();
    expect(conversation.renderedDelegateIndependentTasks).toBe(true);

    // A wake's prompt sync swallows this and runs on the previous prompt,
    // whose section is still on, even though a rebuild would now render it
    // off.
    conversation.setSubagentAllowedTools(new Set(["remember"]));
    throwOnBuild = true;
    expect(() => conversation.buildCurrentSystemPrompt()).toThrow(
      "prompt build failed",
    );

    expect(conversation.renderedDelegateIndependentTasks).toBe(true);
  });

  test("a verbatim system-prompt override captures unknown", () => {
    const conversation = makeConversation("override prompt");
    builtWith = [];

    expect(conversation.buildCurrentSystemPrompt()).toBe("override prompt");

    expect(conversation.renderedDelegateIndependentTasks).toBeNull();
    // The override is returned as is; nothing is built.
    expect(builtWith).toEqual([]);
  });

  test("a replaying wake's recorded state wins over the derivation", () => {
    const conversation = makeConversation();
    // Replaying a channel-sourced conversation that recorded the section off,
    // on a wake whose own scope could spawn.
    conversation.delegateIndependentTasksReplay = false;

    conversation.buildCurrentSystemPrompt();

    expect(conversation.renderedDelegateIndependentTasks).toBe(false);
    expect(lastBuildDelegation()).toBe(false);
  });
});

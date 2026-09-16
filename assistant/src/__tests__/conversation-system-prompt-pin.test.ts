/**
 * A conversation keeps the volatile system-prompt block it started with.
 *
 * The prompt is rebuilt from the workspace before every turn, and the
 * sections behind the cache boundary (first-run ritual, voice markers,
 * connected services) change while a conversation runs. The system prompt
 * heads every request, so a rebuild that differs anywhere re-writes the
 * provider's cache for the entire history behind it. `buildCurrentSystemPrompt`
 * holds a rebuild that differs only behind the boundary, and only a head change
 * reaches the agent loop.
 */
import { describe, expect, mock, test } from "bun:test";

import { CompactionCircuit } from "../agent/compaction-circuit.js";
import type { AgentEvent } from "../agent/loop.js";
import type { Message, ProviderResponse } from "../providers/types.js";

// ---------------------------------------------------------------------------
// Mocks — must precede Conversation import
// ---------------------------------------------------------------------------

mock.module("../providers/registry.js", () => ({
  getProvider: () => ({ name: "mock-provider" }),
  initializeProviders: async () => {},
}));

// The "workspace": whatever a rebuild renders right now.
let workspacePrompt = "";

mock.module("../prompts/system-prompt.js", () => ({
  buildSystemPrompt: () => workspacePrompt,
  applyBootstrapTemplate: () => {},
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

// What the agent loop was last told to send.
const loopPrompts: string[] = [];

mock.module("../agent/loop.js", () => ({
  AgentLoop: class {
    compactionCircuit = new CompactionCircuit("test-conv");
    constructor() {}
    setSystemPrompt(prompt: string) {
      loopPrompts.push(prompt);
    }
    getToolTokenBudget() {
      return 0;
    }
    getResolvedTools() {
      return [];
    }
    getActiveModel() {
      return undefined;
    }
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
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../prompts/cache-boundary.js";

const HEAD = "# Instructions\n\nBe helpful.";
const RITUAL = "# First-Run Ritual\n\nThis is your first conversation.";
const SERVICES = "# Connected Services\n\n- **google**: Connected";

function prompt(head: string, ...suffix: string[]): string {
  return suffix.length === 0
    ? head
    : [head, suffix.join("\n\n")].join(SYSTEM_PROMPT_CACHE_BOUNDARY);
}

function makeConversation(initialPrompt: string): Conversation {
  workspacePrompt = initialPrompt;
  loopPrompts.length = 0;
  const provider = {
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
  return new Conversation("conv-1", provider, initialPrompt, () => {}, "/tmp", {
    maxTokens: 4096,
  });
}

describe("the volatile system-prompt block is held for the conversation's life", () => {
  test("deleting BOOTSTRAP.md mid-conversation does not change the prompt in flight", () => {
    const conversation = makeConversation(prompt(HEAD, RITUAL));

    // The model completes the ritual and deletes BOOTSTRAP.md; the next
    // rebuild has no ritual section and no boundary at all.
    workspacePrompt = prompt(HEAD);
    conversation.syncLoopSystemPrompt();

    expect(conversation.systemPrompt).toBe(prompt(HEAD, RITUAL));
    expect(loopPrompts).toEqual([]);
  });

  test("a service connected mid-conversation waits for the next conversation", () => {
    const conversation = makeConversation(prompt(HEAD, RITUAL));

    workspacePrompt = prompt(HEAD, RITUAL, SERVICES);
    conversation.syncLoopSystemPrompt();

    expect(conversation.systemPrompt).toBe(prompt(HEAD, RITUAL));
    expect(loopPrompts).toEqual([]);
  });

  test("a head change is pushed whole, carrying the volatile block as it stands", () => {
    const conversation = makeConversation(prompt(HEAD, RITUAL));

    // A voice call resolves the caller after construction: a persona section
    // lands in the head, and the ritual is gone from the workspace by now.
    const rescoped = prompt(`${HEAD}\n\n## Persona\n\nThe caller.`, SERVICES);
    workspacePrompt = rescoped;
    conversation.syncLoopSystemPrompt();

    expect(conversation.systemPrompt).toBe(rescoped);
    expect(loopPrompts).toEqual([rescoped]);
  });

  test("a new conversation starts from the workspace as it is now", () => {
    const conversation = makeConversation(prompt(HEAD));

    conversation.syncLoopSystemPrompt();

    expect(conversation.systemPrompt).toBe(prompt(HEAD));
    expect(loopPrompts).toEqual([]);
  });
});

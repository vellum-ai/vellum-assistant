/**
 * Regression: an ephemeral `getOrCreateConversation` call (the empty-state
 * greeting side-chain via POST /v1/btw) must NOT persist a `conversations`
 * row. A persisted row surfaces as an "Untitled" conversation with the literal
 * id "greeting" in every client's sidebar. A normal (non-ephemeral) call still
 * creates the row so real conversations remain sidebar-visible.
 *
 * The DB layer is mocked so the assertion targets exactly the row-creation
 * decision inside `getOrCreateConversation` (`createConversation` /
 * `ensureConversationExists`) rather than the surrounding provider wiring.
 */
import { describe, expect, mock, test } from "bun:test";

import type { Message } from "../providers/types.js";
import { setConfig } from "./helpers/set-config.js";

const mockProviderStub = { name: "mock-provider" };
mock.module("../providers/registry.js", () => ({
  getProvider: () => mockProviderStub,
  initializeProviders: async () => {},
  listProviders: () => ["anthropic", "openai", "gemini"],
  resolveProviderFromConnection: async () => mockProviderStub,
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
  callSites: {
    mainAgent: {
      provider: "anthropic",
      provider_connection: "anthropic-conn",
      model: "claude-opus-4-6",
    },
  },
});
setConfig("memory", { enabled: false, v2: { enabled: false } });

mock.module("../prompts/system-prompt.js", () => ({
  buildSystemPrompt: () => "system prompt",
}));

mock.module("../prompts/persona-resolver.js", () => ({
  resolvePersonaContext: () => ({
    userPersona: undefined,
    channelPersona: undefined,
    userSlug: undefined,
  }),
}));

mock.module("../permissions/trust-store.js", () => ({
  clearCache: () => {},
}));

mock.module("../security/secret-allowlist.js", () => ({
  resetAllowlist: () => {},
}));

mock.module("../workspace/turn-commit.js", () => ({
  commitTurnChanges: async () => {},
}));

mock.module("../workspace/git-service.js", () => ({
  getWorkspaceGitService: () => ({
    ensureInitialized: async () => {},
    commitIfDirty: async () => ({ committed: false }),
  }),
}));

// The row-creation spies. `getConversation` returns null so the conversation
// reads as brand-new — the branch that would create a row.
const mockCreateConversation = mock((_opts?: unknown) => ({ id: "conv-x" }));
const mockEnsureConversationExists = mock((_id: string) => true);

mock.module("../persistence/conversation-crud.js", () => ({
  ADOPTABLE_CONVERSATION_ID_RE: /^[A-Za-z0-9_-]{1,128}$/,
  createConversation: mockCreateConversation,
  ensureConversationExists: mockEnsureConversationExists,
  getConversation: () => null,
  getMessages: () => [],
  setConversationProcessingStartedAt: () => {},
  isConversationProcessing: () => false,
}));

mock.module("../persistence/conversation-queries.js", () => ({
  listConversations: () => [],
}));

mock.module("../memory/retriever.js", () => ({
  buildMemoryRecall: async () => ({
    enabled: false,
    degraded: false,
    injectedText: "",
    semanticHits: 0,
    injectedTokens: 0,
    latencyMs: 0,
  }),
  injectMemoryRecallAsUserBlock: (msgs: Message[]) => msgs,
}));

mock.module("../agent/loop.js", () => ({
  AgentLoop: class {
    constructor() {}
    getToolTokenBudget() {
      return 0;
    }
    getResolvedTools() {
      return [];
    }
    async run(options: { messages: Message[] }): Promise<Message[]> {
      return [
        ...options.messages,
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
      ];
    }
  },
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

import {
  clearAllActiveConversations,
  getOrCreateConversation,
} from "../daemon/conversation-store.js";

describe("getOrCreateConversation ephemeral flag", () => {
  test("ephemeral call does not persist a conversations row", async () => {
    clearAllActiveConversations();
    mockCreateConversation.mockClear();
    mockEnsureConversationExists.mockClear();

    await getOrCreateConversation("greeting", { ephemeral: true });

    expect(mockEnsureConversationExists).not.toHaveBeenCalled();
    expect(mockCreateConversation).not.toHaveBeenCalled();
  });

  test("non-ephemeral call persists a conversations row", async () => {
    clearAllActiveConversations();
    mockCreateConversation.mockClear();
    mockEnsureConversationExists.mockClear();

    await getOrCreateConversation("real-conversation-id");

    expect(mockEnsureConversationExists).toHaveBeenCalledWith(
      "real-conversation-id",
    );
  });
});

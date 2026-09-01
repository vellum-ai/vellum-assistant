/**
 * When an acquire writes a `conversations` row, and when it refuses to.
 *
 * Regression: an ephemeral `getOrCreateConversation` call (the empty-state
 * greeting side-chain via POST /v1/btw) must NOT persist a `conversations`
 * row. A persisted row surfaces as an "Untitled" conversation with the literal
 * id "greeting" in every client's sidebar. A normal (non-ephemeral) call still
 * creates the row so real conversations remain sidebar-visible.
 *
 * `getConversationIfExists` refuses for a different reason: its callers run
 * queued work whose conversation can be deleted before the job starts, and
 * writing the row back would bring the conversation home. The window that
 * matters is the provider, prompt, and tool setup the acquire awaits, which a
 * delete can land in the middle of.
 *
 * The DB layer is mocked so the assertions target exactly the row-creation
 * decision inside the acquire (`createConversation` /
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

/**
 * Whether the `conversations` row reads as present. Default false, which is
 * the brand-new conversation the row-creation tests below need.
 */
let conversationRowPresent = false;

/**
 * Set to model a delete that lands while the acquire is awaiting its setup
 * work: the row reads present when the acquire starts and gone by the time it
 * would insert.
 */
let deleteDuringSetup = false;

/**
 * Set to hold an acquire inside its setup work until the test resolves it,
 * which is what lets a second acquire join the first one's flight and lets a
 * delete land while both are waiting on it.
 */
let holdSetup: Promise<void> | null = null;

mock.module("../prompts/system-prompt.js", () => ({
  buildSystemPrompt: async () => {
    // Awaited by the acquire between its first read of the row and the insert,
    // so this is the window a delete has to land in.
    if (deleteDuringSetup) {
      conversationRowPresent = false;
    }
    if (holdSetup) {
      await holdSetup;
    }
    return "system prompt";
  },
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

// The row-creation spies. `getConversation` answers from
// `conversationRowPresent`, which starts false so the conversation reads as
// brand-new: the branch that would create a row.
// Both write the row, so both leave it readable, which is what lets a test
// tell an acquire that re-created a conversation from one that did not.
const mockCreateConversation = mock((_opts?: unknown) => {
  conversationRowPresent = true;
  return { id: "conv-x" };
});
const mockEnsureConversationExists = mock((_id: string) => {
  conversationRowPresent = true;
  return true;
});

mock.module("../persistence/conversation-crud.js", () => ({
  ADOPTABLE_CONVERSATION_ID_RE: /^[A-Za-z0-9_-]{1,128}$/,
  createConversation: mockCreateConversation,
  ensureConversationExists: mockEnsureConversationExists,
  getConversation: (id: string) => (conversationRowPresent ? { id } : null),
  getMessages: () => [],
  setConversationProcessingStartedAt: () => {},
  isConversationProcessing: () => false,
}));

mock.module("../persistence/conversation-queries.js", () => ({
  listConversations: () => [],
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
  getConversationIfExists,
  getOrCreateConversation,
} from "../daemon/conversation-store.js";

function resetAcquireState(): void {
  clearAllActiveConversations();
  mockCreateConversation.mockClear();
  mockEnsureConversationExists.mockClear();
  conversationRowPresent = false;
  deleteDuringSetup = false;
  holdSetup = null;
}

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

    // No trust context on this call, so no origin is asserted: the row is
    // left unattributed for the first inbound message to claim, rather than
    // being guessed as native.
    expect(mockEnsureConversationExists).toHaveBeenCalledWith(
      "real-conversation-id",
      undefined,
    );
  });
});

describe("getConversationIfExists", () => {
  test("returns null for a conversation whose row is already gone", async () => {
    resetAcquireState();

    expect(await getConversationIfExists("deleted-conversation")).toBeNull();

    expect(mockEnsureConversationExists).not.toHaveBeenCalled();
    expect(mockCreateConversation).not.toHaveBeenCalled();
  });

  test("returns null when the delete lands during provider and tool setup", async () => {
    // The window the up-front read cannot cover: the acquire awaits provider
    // resolution, the system prompt, and tool setup before it reaches the
    // insert, and a delete inside those awaits used to be answered by writing
    // the row back.
    resetAcquireState();
    conversationRowPresent = true;
    deleteDuringSetup = true;

    expect(await getConversationIfExists("deleted-mid-setup")).toBeNull();

    expect(mockEnsureConversationExists).not.toHaveBeenCalled();
    expect(mockCreateConversation).not.toHaveBeenCalled();
  });

  test("builds the conversation when its row survives the setup", async () => {
    resetAcquireState();
    conversationRowPresent = true;

    const conversation = await getConversationIfExists("live-conversation");

    expect(conversation).not.toBeNull();
    // The row was there all along, so nothing had to write one.
    expect(mockEnsureConversationExists).not.toHaveBeenCalled();
    expect(mockCreateConversation).not.toHaveBeenCalled();
  });

  test("does not inherit an instance from the acquire it joined", async () => {
    // Both acquires share one flight, and they do not share a contract. The
    // creating caller builds its conversation whatever became of the row,
    // which is its own business; an observer that took the same instance
    // would be answering someone else's question.
    resetAcquireState();
    conversationRowPresent = true;
    let releaseSetup = () => {};
    holdSetup = new Promise<void>((resolve) => {
      releaseSetup = resolve;
    });

    // Ephemeral, so the creating acquire never writes the row back and the
    // delete below stands.
    const creating = getOrCreateConversation("joined-conversation", {
      ephemeral: true,
    });
    // Reaches the flight the creating acquire registered before its first
    // await, and waits on it.
    const observing = getConversationIfExists("joined-conversation");

    conversationRowPresent = false;
    releaseSetup();

    expect(await creating).not.toBeNull();
    expect(await observing).toBeNull();
    expect(mockEnsureConversationExists).not.toHaveBeenCalled();
    expect(mockCreateConversation).not.toHaveBeenCalled();
  });
});

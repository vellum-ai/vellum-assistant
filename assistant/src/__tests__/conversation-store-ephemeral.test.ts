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
import { describe, expect, mock, spyOn, test } from "bun:test";

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
 * The `created_at` the row reads with, which is what tells one incarnation of
 * an id from the next. Every write below stamps a fresh one, the way an insert
 * does.
 */
let conversationCreatedAt = 1000;

/**
 * Set to model a delete that lands while the acquire is awaiting its setup
 * work: the row reads present when the acquire starts and gone by the time it
 * would insert.
 */
let deleteDuringSetup = false;

/**
 * Set to model a delete that lands while the acquire is hydrating the instance
 * it just built, which is the window before it reaches the registry.
 */
let deleteDuringHydration = false;

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

/** Write the row the way an insert does, under a fresh `created_at`. */
function writeConversationRow(): void {
  conversationRowPresent = true;
  conversationCreatedAt += 1;
}

// The row-creation spies. `getConversation` answers from
// `conversationRowPresent`, which starts false so the conversation reads as
// brand-new: the branch that would create a row. Both spies leave the row
// readable under a `created_at` of their own, which is what lets a test tell
// the conversation an acquire was asked about from one written since.
const mockCreateConversation = mock((_opts?: unknown) => {
  writeConversationRow();
  return { id: "conv-x" };
});
const mockEnsureConversationExists = mock((_id: string) => {
  // Matches the real one, which reports false and writes nothing when the row
  // is already there.
  if (conversationRowPresent) {
    return false;
  }
  writeConversationRow();
  return true;
});

mock.module("../persistence/conversation-crud.js", () => ({
  ADOPTABLE_CONVERSATION_ID_RE: /^[A-Za-z0-9_-]{1,128}$/,
  createConversation: mockCreateConversation,
  ensureConversationExists: mockEnsureConversationExists,
  getConversation: (id: string) =>
    conversationRowPresent ? { id, createdAt: conversationCreatedAt } : null,
  getMessages: () => {
    // Read by `loadFromDb`, which the acquire awaits after building the
    // instance and before it reaches the registry.
    if (deleteDuringHydration) {
      conversationRowPresent = false;
    }
    return [];
  },
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

import { Conversation } from "../daemon/conversation.js";
import {
  conversationCount,
  findConversation,
} from "../daemon/conversation-registry.js";
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
  conversationCreatedAt += 1;
  deleteDuringSetup = false;
  deleteDuringHydration = false;
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

  test("does not accept a row the acquire it joined wrote back", async () => {
    // The creating caller it shares flight with writes the row back when the
    // delete lands inside that caller's setup, so by the time this one looks
    // the id names a row again. Reading presence alone cannot tell that row
    // from the one this caller was asked about, and persisting into it would
    // put the frame in a conversation created after the deletion.
    resetAcquireState();
    conversationRowPresent = true;
    let releaseSetup = () => {};
    holdSetup = new Promise<void>((resolve) => {
      releaseSetup = resolve;
    });

    const creating = getOrCreateConversation("recreated-conversation");
    const observing = getConversationIfExists("recreated-conversation");

    conversationRowPresent = false;
    releaseSetup();

    // The creating caller builds whatever became of the row, which is its own
    // contract and unchanged.
    expect(await creating).not.toBeNull();
    expect(mockEnsureConversationExists).toHaveBeenCalledTimes(1);
    expect(conversationRowPresent).toBe(true);

    expect(await observing).toBeNull();
  });

  test("disposes rather than registers an instance whose row went away", async () => {
    // Hydration awaits, so the row can go between the read that let this build
    // and the registry write. Registering leaves an active conversation with
    // no row behind it, which later session work finds and reuses.
    resetAcquireState();
    conversationRowPresent = true;
    deleteDuringHydration = true;
    const disposeSpy = spyOn(Conversation.prototype, "dispose");

    try {
      expect(await getConversationIfExists("hydrated-conversation")).toBeNull();

      expect(findConversation("hydrated-conversation")).toBeUndefined();
      expect(conversationCount()).toBe(0);
      expect(conversationRowPresent).toBe(false);
      // The instance it built is torn down rather than left to leak its
      // timers and proxies.
      expect(disposeSpy).toHaveBeenCalledTimes(1);
    } finally {
      disposeSpy.mockRestore();
    }
  });
});

describe("acquisitions sharing one flight", () => {
  test("creating callers behind a declined flight build one conversation", async () => {
    // A flight that declines to create leaves everyone waiting on it with no
    // answer, and each of them was asked to build. Building unconditionally
    // from there gives one id two instances: the registry keeps whichever was
    // written last, and the other one runs with its own processing flag and
    // its own queue.
    resetAcquireState();
    conversationRowPresent = true;
    let releaseSetup = () => {};
    holdSetup = new Promise<void>((resolve) => {
      releaseSetup = resolve;
    });

    // Passes its up-front read, publishes the flight, then waits inside setup.
    const observing = getConversationIfExists("herd-conversation");
    // Both reach that flight and wait on it.
    const firstCreating = getOrCreateConversation("herd-conversation");
    const secondCreating = getOrCreateConversation("herd-conversation");

    // The delete the observing acquire will refuse on when it wakes.
    conversationRowPresent = false;
    releaseSetup();

    expect(await observing).toBeNull();
    const first = await firstCreating;
    const second = await secondCreating;

    // One acquire built; the other joined the flight it published.
    expect(first).toBe(second);
    expect(findConversation("herd-conversation")).toBe(first);
    expect(conversationCount()).toBe(1);
  });

  test("a joiner holding a later incarnation does not inherit the decline", async () => {
    // The flight it joined was asked about the row that has since been
    // deleted, and reports that. This caller was accepted for the row written
    // after it, which is still there, so taking the null would drop work the
    // conversation on screen can still accept.
    resetAcquireState();
    conversationRowPresent = true;
    let releaseSetup = () => {};
    holdSetup = new Promise<void>((resolve) => {
      releaseSetup = resolve;
    });

    // Passes its up-front read, publishes the flight, then waits inside setup.
    const doomed = getConversationIfExists("rejoin-conversation");

    // The delete the flight above will refuse on, and the recreate the caller
    // below is accepted for.
    conversationRowPresent = false;
    writeConversationRow();
    const acceptedIncarnation = conversationCreatedAt;

    // Reads the recreated row, finds no instance, and joins the flight above.
    const joining = getConversationIfExists("rejoin-conversation");
    releaseSetup();

    expect(await doomed).toBeNull();

    const conversation = await joining;
    expect(conversation).not.toBeNull();
    expect(findConversation("rejoin-conversation")).toBe(conversation!);
    // The row it was accepted for, untouched: a non-creating acquire that
    // finds its own row present writes nothing back.
    expect(conversationCreatedAt).toBe(acceptedIncarnation);
    expect(mockEnsureConversationExists).not.toHaveBeenCalled();
    expect(mockCreateConversation).not.toHaveBeenCalled();
  });

  test("a joiner whose own row is gone still answers null", async () => {
    // The control on the retry above. Reconsulting is for a caller whose row
    // outlived the flight's, and a caller with no row at all has to keep
    // getting the answer its callers reclaim uploads on.
    resetAcquireState();
    conversationRowPresent = true;
    let releaseSetup = () => {};
    holdSetup = new Promise<void>((resolve) => {
      releaseSetup = resolve;
    });

    const doomed = getConversationIfExists("rejoin-absent-conversation");
    // Joins while the row is still the one both were asked about.
    const joining = getConversationIfExists("rejoin-absent-conversation");

    // Deleted for good, with nothing written back.
    conversationRowPresent = false;
    releaseSetup();

    expect(await doomed).toBeNull();
    expect(await joining).toBeNull();
    expect(conversationCount()).toBe(0);
    expect(mockEnsureConversationExists).not.toHaveBeenCalled();
    expect(mockCreateConversation).not.toHaveBeenCalled();
  });
});

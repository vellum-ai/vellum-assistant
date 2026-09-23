import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../providers/registry.js", () => ({
  getProvider: () => ({ name: "mock-provider" }),
  initializeProviders: async () => {},
}));

mock.module("../../prompts/system-prompt.js", () => ({
  buildSystemPrompt: () => "system prompt",
}));

mock.module("../../permissions/trust-store.js", () => ({
  clearCache: () => {},
}));

mock.module("../../security/secret-allowlist.js", () => ({
  resetAllowlist: () => {},
}));

interface MockRow {
  id: string;
  role: string;
  content: unknown;
  createdAt: number;
  metadata: string | null;
}

let mockRows: MockRow[] = [];
let mockConversation: Record<string, unknown> | null = null;
const loadedConversationIds: string[] = [];

mock.module("../../persistence/conversation-crud.js", () => ({
  setConversationProcessingStartedAt: () => {},
  isConversationProcessing: () => false,
  updateConversationContextWindow: (
    _conversationId: string,
    contextSummary: string,
    contextCompactedMessageCount: number,
  ) => {
    mockConversation = {
      ...mockConversation,
      contextSummary,
      contextCompactedMessageCount,
    };
  },
  deleteMessageById: () => {},
  updateConversationTitle: () => {},
  updateConversationUsage: () => {},
  provenanceFromTrustContext: () => ({
    source: "user",
    trustContext: undefined,
  }),
  getConversationOriginInterface: () => null,
  getConversationOriginChannel: () => null,
  getMessages: (conversationId: string) => {
    loadedConversationIds.push(conversationId);
    return mockRows;
  },
  getConversation: () => mockConversation,
  createConversation: () => ({ id: "conv-shared" }),
  addMessage: async () => ({ id: "persisted" }),
  setConversationHistoryStrippedAt: () => {},
  setConversationOriginChannelIfUnset: () => {},
  setConversationOriginInterfaceIfUnset: () => {},
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
}));

mock.module("../../persistence/conversation-queries.js", () => ({
  listConversations: () => [],
}));

/** Active participants, as `conversationId:principalId`. */
const participants = new Set<string>();

mock.module("../../persistence/conversation-participants.js", () => ({
  addParticipant: () => true,
  removeParticipant: () => true,
  isParticipant: (conversationId: string, principalId: string) =>
    participants.has(`${conversationId}:${principalId}`),
  listParticipants: () => [],
  listConversationIdsForPrincipal: () => [],
}));

import { Conversation } from "../conversation.js";
import { applyCompactionResult } from "../conversation-agent-loop.js";
import type { TrustContext } from "../trust-context-types.js";

const CONVERSATION_ID = "conv-shared";
const ALICE = "principal-alice";
const BOB = "principal-bob";

const GUARDIAN: TrustContext = {
  sourceChannel: "vellum",
  trustClass: "guardian",
};

function sharedContact(principalId: string): TrustContext {
  return {
    sourceChannel: "vellum-shared",
    trustClass: "trusted_contact",
    requesterExternalUserId: principalId,
    requesterChatId: principalId,
  };
}

const SLACK_CONTACT: TrustContext = {
  sourceChannel: "slack",
  trustClass: "trusted_contact",
  requesterExternalUserId: "U-alice",
};

const FENCED_CONTACT_TEXT =
  '<external_content source="webhook">\nCan you check the plan?\n</external_content>';

function meta(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}

function guardianMeta(fields: Record<string, unknown> = {}): string {
  return meta({ provenanceTrustClass: "guardian", ...fields });
}

/**
 * A guardian exchange with everything a contact must not see around the
 * transcript itself, followed by a contact's message.
 */
function seedSharedTranscript(): void {
  mockRows = [
    {
      id: "g-user-1",
      role: "user",
      content: [
        {
          type: "text",
          text: "<memory>\nlegacy embedded memory\n</memory>",
        },
        { type: "text", text: "Draft the launch plan." },
      ],
      createdAt: 100,
      metadata: guardianMeta({
        memoryInjectedBlock: "guardian dynamic memory",
        memoryV2StaticBlock: "<info>\nguardian static memory\n</info>",
        turnContextBlock: "<turn_context>\nguardian context\n</turn_context>",
        workspaceBlock: "<workspace>\nguardian workspace\n</workspace>",
      }),
    },
    {
      id: "g-assistant-1",
      role: "assistant",
      content: [
        { type: "thinking", thinking: "guardian reasoning", signature: "sig" },
        {
          type: "tool_use",
          id: "tool-1",
          name: "file_read",
          input: { path: "/private/notes.md" },
        },
      ],
      createdAt: 110,
      metadata: guardianMeta(),
    },
    {
      id: "g-user-2",
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: "guardian private file contents",
        },
      ],
      createdAt: 120,
      metadata: guardianMeta(),
    },
    {
      id: "g-assistant-2",
      role: "assistant",
      content: [{ type: "text", text: "Here is the launch plan." }],
      createdAt: 130,
      metadata: guardianMeta(),
    },
    {
      id: "c-user-1",
      role: "user",
      content: [{ type: "text", text: FENCED_CONTACT_TEXT }],
      createdAt: 200,
      metadata: meta({
        provenanceTrustClass: "trusted_contact",
        provenanceSourceChannel: "vellum-shared",
      }),
    },
  ];
}

function makeConversation(trust: TrustContext): Conversation {
  const provider = {
    name: "mock",
    sendMessage: async () => ({
      content: [],
      model: "mock",
      usage: { inputTokens: 0, outputTokens: 0 },
      stopReason: "end_turn",
    }),
  };
  const conversation = new Conversation(
    CONVERSATION_ID,
    provider,
    "system prompt",
    () => {},
    "/tmp",
    { maxTokens: 4096 },
  );
  conversation.setTrustContext(trust);
  return conversation;
}

async function loadAs(trust: TrustContext): Promise<Conversation> {
  const conversation = makeConversation(trust);
  await conversation.loadFromDb();
  return conversation;
}

/** Every block of the loaded history, serialized, for leak checks. */
function historyText(conversation: Conversation): string {
  return JSON.stringify(conversation.getMessages());
}

function texts(conversation: Conversation): string[] {
  return conversation
    .getMessages()
    .flatMap((message) => message.content)
    .filter((block) => block.type === "text")
    .map((block) => (block as { text: string }).text);
}

const GUARDIAN_ONLY_MATERIAL = [
  "legacy embedded memory",
  "guardian dynamic memory",
  "guardian static memory",
  "guardian context",
  "guardian workspace",
  "guardian reasoning",
  "/private/notes.md",
  "guardian private file contents",
];

beforeEach(() => {
  mockRows = [];
  mockConversation = {
    id: CONVERSATION_ID,
    contextSummary: "Summary of earlier guardian turns",
    contextCompactedMessageCount: 1,
    historyStrippedAt: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalEstimatedCost: 0,
  };
  participants.clear();
  loadedConversationIds.length = 0;
});

describe("contact turn in a shared conversation", () => {
  beforeEach(() => {
    participants.add(`${CONVERSATION_ID}:${ALICE}`);
    seedSharedTranscript();
  });

  test("has the transcript every participant can read", async () => {
    const conversation = await loadAs(sharedContact(ALICE));

    expect(texts(conversation)).toEqual([
      "Draft the launch plan.",
      "Here is the launch plan.",
      FENCED_CONTACT_TEXT,
    ]);
  });

  test("leaves out memory, turn context, reasoning and tool traffic", async () => {
    const conversation = await loadAs(sharedContact(ALICE));
    const history = historyText(conversation);

    for (const material of GUARDIAN_ONLY_MATERIAL) {
      expect(history).not.toContain(material);
    }
  });

  test("leaves out the compaction summary and slices nothing", async () => {
    const conversation = await loadAs(sharedContact(ALICE));

    expect(historyText(conversation)).not.toContain(
      "Summary of earlier guardian turns",
    );
    expect(texts(conversation)[0]).toBe("Draft the launch plan.");
  });

  test("keeps the fence on a contact's message", async () => {
    const conversation = await loadAs(sharedContact(ALICE));

    expect(texts(conversation)).toContain(FENCED_CONTACT_TEXT);
  });

  test("reads only this conversation's rows", async () => {
    await loadAs(sharedContact(ALICE));

    expect(new Set(loadedConversationIds)).toEqual(new Set([CONVERSATION_ID]));
  });

  test("shows a send_user_message reply as the message it delivered", async () => {
    mockRows = [
      {
        id: "g-user",
        role: "user",
        content: [{ type: "text", text: "Summarize it." }],
        createdAt: 100,
        metadata: guardianMeta(),
      },
      {
        id: "g-assistant",
        role: "assistant",
        content: [
          { type: "text", text: "scratchpad notes" },
          {
            type: "tool_use",
            id: "sum-1",
            name: "send_user_message",
            input: { message: "Here is the summary." },
          },
        ],
        createdAt: 110,
        metadata: guardianMeta({ assistantTextVisibility: "private" }),
      },
    ];

    const conversation = await loadAs(sharedContact(ALICE));

    expect(texts(conversation)).toEqual([
      "Summarize it.",
      "Here is the summary.",
    ]);
    expect(historyText(conversation)).not.toContain("scratchpad notes");
  });

  test("leaves out a row restricted to another reader", async () => {
    mockRows = [
      {
        id: "g-user",
        role: "user",
        content: [{ type: "text", text: "Hello everyone." }],
        createdAt: 100,
        metadata: guardianMeta(),
      },
      {
        id: "to-bob",
        role: "assistant",
        content: [{ type: "text", text: "A note for Bob only." }],
        createdAt: 110,
        metadata: guardianMeta({
          audience: { kind: "oneReader", userId: BOB },
        }),
      },
      {
        id: "to-alice",
        role: "assistant",
        content: [{ type: "text", text: "A note for Alice only." }],
        createdAt: 120,
        metadata: guardianMeta({
          audience: { kind: "oneReader", userId: ALICE },
        }),
      },
    ];

    const conversation = await loadAs(sharedContact(ALICE));
    const history = historyText(conversation);

    expect(history).toContain("A note for Alice only.");
    expect(history).not.toContain("A note for Bob only.");
  });

  test("leaves out a hidden row", async () => {
    mockRows = [
      {
        id: "hidden",
        role: "user",
        content: [{ type: "text", text: "hidden priming prompt" }],
        createdAt: 100,
        metadata: guardianMeta({ hidden: true }),
      },
      {
        id: "visible",
        role: "user",
        content: [{ type: "text", text: "Visible message." }],
        createdAt: 110,
        metadata: guardianMeta(),
      },
    ];

    const conversation = await loadAs(sharedContact(ALICE));

    expect(texts(conversation)).toEqual(["Visible message."]);
  });
});

describe("contact turn outside a shared conversation", () => {
  beforeEach(() => {
    seedSharedTranscript();
  });

  test("a contact who is not a participant sees only untrusted rows", async () => {
    const conversation = await loadAs(sharedContact(ALICE));

    expect(texts(conversation)).toEqual([FENCED_CONTACT_TEXT]);
  });

  test("a Slack contact keeps the narrow view even with participants", async () => {
    participants.add(`${CONVERSATION_ID}:${ALICE}`);
    participants.add(`${CONVERSATION_ID}:U-alice`);

    const conversation = await loadAs(SLACK_CONTACT);

    expect(texts(conversation)).toEqual([FENCED_CONTACT_TEXT]);
  });

  test("leaves out memory, reasoning, tool traffic and the summary", async () => {
    const conversation = await loadAs(sharedContact(ALICE));
    const history = historyText(conversation);

    for (const material of [
      ...GUARDIAN_ONLY_MATERIAL,
      "Summary of earlier guardian turns",
    ]) {
      expect(history).not.toContain(material);
    }
  });
});

describe("history reuse across actors", () => {
  beforeEach(() => {
    participants.add(`${CONVERSATION_ID}:${ALICE}`);
    participants.add(`${CONVERSATION_ID}:${BOB}`);
    seedSharedTranscript();
  });

  test("a second contact's turn reloads rather than reusing the first's", async () => {
    mockRows.push({
      id: "to-alice",
      role: "assistant",
      content: [{ type: "text", text: "A note for Alice only." }],
      createdAt: 300,
      metadata: guardianMeta({
        audience: { kind: "oneReader", userId: ALICE },
      }),
    });
    const conversation = await loadAs(sharedContact(ALICE));
    expect(historyText(conversation)).toContain("A note for Alice only.");

    conversation.setTrustContext(sharedContact(BOB));
    await conversation.ensureActorScopedHistory();

    expect(historyText(conversation)).not.toContain("A note for Alice only.");
  });

  test("a removed participant's next load is the narrow view", async () => {
    const conversation = await loadAs(sharedContact(ALICE));
    expect(texts(conversation)).toContain("Draft the launch plan.");

    participants.delete(`${CONVERSATION_ID}:${ALICE}`);
    await conversation.ensureActorScopedHistory();

    expect(texts(conversation)).toEqual([FENCED_CONTACT_TEXT]);
  });

  test("the guardian's next turn gets the full history back", async () => {
    const conversation = await loadAs(sharedContact(ALICE));

    conversation.setTrustContext(GUARDIAN);
    await conversation.ensureActorScopedHistory();

    const history = historyText(conversation);
    expect(history).toContain("guardian reasoning");
    expect(history).toContain("Summary of earlier guardian turns");
  });
});

describe("another contact's turns in a shared conversation", () => {
  function contactTurnMeta(principalId: string): string {
    return meta({
      provenanceTrustClass: "trusted_contact",
      provenanceSourceChannel: "vellum-shared",
      provenanceRequesterIdentifier: principalId,
    });
  }

  beforeEach(() => {
    participants.add(`${CONVERSATION_ID}:${ALICE}`);
    participants.add(`${CONVERSATION_ID}:${BOB}`);
    seedSharedTranscript();
    mockRows.push(
      {
        id: "a-user",
        role: "user",
        content: [{ type: "text", text: FENCED_CONTACT_TEXT }],
        createdAt: 300,
        metadata: contactTurnMeta(ALICE),
      },
      {
        id: "a-assistant-1",
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "reasoning on Alice's turn",
            signature: "sig",
          },
          {
            type: "tool_use",
            id: "alice-tool",
            name: "web_fetch",
            input: { url: "https://example.com/alice-lookup" },
          },
        ],
        createdAt: 310,
        metadata: contactTurnMeta(ALICE),
      },
      {
        id: "a-tool-result",
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "alice-tool",
            content: "result fetched on Alice's turn",
          },
        ],
        createdAt: 320,
        metadata: contactTurnMeta(ALICE),
      },
      {
        id: "a-assistant-2",
        role: "assistant",
        content: [{ type: "text", text: "Here is what I found for Alice." }],
        createdAt: 330,
        metadata: contactTurnMeta(ALICE),
      },
    );
  });

  const ALICE_TURN_MATERIAL = [
    "reasoning on Alice's turn",
    "https://example.com/alice-lookup",
    "result fetched on Alice's turn",
  ];

  test("another participant gets only what the contact view shows", async () => {
    const conversation = await loadAs(sharedContact(BOB));
    const history = historyText(conversation);

    for (const material of [
      ...ALICE_TURN_MATERIAL,
      ...GUARDIAN_ONLY_MATERIAL,
    ]) {
      expect(history).not.toContain(material);
    }
    expect(texts(conversation)).toContain("Here is what I found for Alice.");
  });

  test("the contact's own next turn keeps their turn as stored", async () => {
    const conversation = await loadAs(sharedContact(ALICE));
    const history = historyText(conversation);

    for (const material of ALICE_TURN_MATERIAL) {
      expect(history).toContain(material);
    }
    for (const material of GUARDIAN_ONLY_MATERIAL) {
      expect(history).not.toContain(material);
    }
  });

  test("a contact row with no requester identifier is projected", async () => {
    mockRows = mockRows.map((row) =>
      row.id === "a-tool-result"
        ? {
            ...row,
            metadata: meta({
              provenanceTrustClass: "trusted_contact",
              provenanceSourceChannel: "vellum-shared",
            }),
          }
        : row,
    );

    const conversation = await loadAs(sharedContact(ALICE));

    expect(historyText(conversation)).not.toContain(
      "result fetched on Alice's turn",
    );
  });

  test("the guardian's view is unchanged", async () => {
    const conversation = await loadAs(GUARDIAN);
    const history = historyText(conversation);

    for (const material of ALICE_TURN_MATERIAL) {
      expect(history).toContain(material);
    }
    expect(history).toContain("guardian reasoning");
  });
});

describe("compaction on a contact's turn", () => {
  beforeEach(() => {
    participants.add(`${CONVERSATION_ID}:${ALICE}`);
    seedSharedTranscript();
  });

  /** A compaction of the resident history that summarizes its first rows. */
  function compactionOf(
    conversation: Conversation,
    compactedRows: number,
    summaryText: string,
  ): Parameters<typeof applyCompactionResult>[1] {
    return {
      messages: [
        { role: "user", content: [{ type: "text", text: summaryText }] },
        ...conversation.getMessages().slice(compactedRows),
      ],
      compactedPersistedMessages: compactedRows,
      previousEstimatedInputTokens: 12000,
      estimatedInputTokens: 3000,
      maxInputTokens: 100000,
      thresholdTokens: 80000,
      compactedMessages: compactedRows,
      summaryCalls: 1,
      summaryInputTokens: 100,
      summaryOutputTokens: 20,
      summaryModel: "mock-model",
      summaryText,
    };
  }

  test("stays in memory and leaves the guardian's next load unchanged", async () => {
    // GIVEN the guardian's history and persisted compaction state
    const guardianHistory = historyText(await loadAs(GUARDIAN));
    const persisted = { ...mockConversation };

    // WHEN Alice's turn compacts her projected view
    const conversation = await loadAs(sharedContact(ALICE));
    await applyCompactionResult(
      conversation,
      compactionOf(conversation, 2, "Summary of Alice's view"),
      () => {},
      null,
    );

    // THEN her resident history is compacted
    expect(texts(conversation)).toEqual([
      "Summary of Alice's view",
      FENCED_CONTACT_TEXT,
    ]);
    // AND nothing persisted changed, so the guardian's next turn loads the
    // same history it had before
    expect(mockConversation).toEqual(persisted);
    conversation.setTrustContext(GUARDIAN);
    await conversation.ensureActorScopedHistory();
    expect(historyText(conversation)).toBe(guardianHistory);
  });

  test("a guardian compaction still advances the persisted state", async () => {
    // GIVEN the guardian's history, one row already compacted
    const conversation = await loadAs(GUARDIAN);

    // WHEN the guardian's turn compacts two more rows
    await applyCompactionResult(
      conversation,
      compactionOf(conversation, 2, "Newer guardian summary"),
      () => {},
      null,
    );

    // THEN the persisted state records the new summary and boundary
    expect(mockConversation).toMatchObject({
      contextSummary: "Newer guardian summary",
      contextCompactedMessageCount: 3,
    });
    // AND the next guardian load starts from them
    const reloaded = await loadAs(GUARDIAN);
    const history = historyText(reloaded);
    expect(history).toContain("Newer guardian summary");
    expect(history).not.toContain("guardian reasoning");
  });
});

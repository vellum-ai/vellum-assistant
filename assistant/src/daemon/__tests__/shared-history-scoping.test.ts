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
  updateConversationContextWindow: () => {},
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

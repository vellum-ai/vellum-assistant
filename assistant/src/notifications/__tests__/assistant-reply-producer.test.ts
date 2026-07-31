/**
 * Tests for `assistant-reply-producer.ts`.
 *
 * Coverage matrix:
 *   - Qualifying unseen reply in a user conversation emits exactly one signal,
 *     asserted on the full shape (dedupeKey, absent `requiresConversation`).
 *   - Every non-"user" kind of the shared `resolveConversationKind` classifier
 *     is silent.
 *   - An `automated: true` initiating user message is silent.
 *   - A hidden lifecycle row (subagent / ACP notification) opening the turn is
 *     silent.
 *   - A live phone / in-app voice utterance opening the turn is silent.
 *   - A turn opened from a messaging channel (Slack, Telegram, …) is silent,
 *     while the in-app `vellum` channel and an unstamped row still emit.
 *   - An already-seen reply is silent.
 *   - A tool-only reply (empty text preview) is silent.
 *   - A throwing dependency is swallowed, not propagated.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { AttentionState } from "../../persistence/conversation-attention-store.js";
import type {
  ConversationRow,
  MessageRow,
} from "../../persistence/conversation-crud.js";
import { resolveConversationKind } from "../../persistence/conversation-types.js";
import { MEMORY_V2_CONSOLIDATION_SOURCE } from "../../plugins/defaults/memory/substrate/constants.js";
import type { ContentBlock } from "../../providers/types.js";

// ── Module mocks ───────────────────────────────────────────────────────
//
// `mock.module` is hoisted, so these intercepts apply before the module under
// test resolves its imports. Each test rewrites the module-scoped fixtures
// below and inspects the captured emit calls afterwards.

const emitCalls: any[] = [];
let conversationRow: ConversationRow | null = null;
let assistantRow: MessageRow | null = null;
let userRows: MessageRow[] = [];
let attentionState: AttentionState | null = null;
let getConversationShouldThrow = false;

mock.module("../emit-signal.js", () => ({
  emitNotificationSignal: async (params: any) => {
    emitCalls.push(params);
    return {
      signalId: "sig-1",
      deduplicated: false,
      dispatched: true,
      reason: "ok",
      deliveryResults: [],
    };
  },
}));

const realCrud = await import("../../persistence/conversation-crud.js");
mock.module("../../persistence/conversation-crud.js", () => ({
  ...realCrud,
  getConversation: () => {
    if (getConversationShouldThrow) {
      throw new Error("simulated conversation lookup failure");
    }
    return conversationRow;
  },
  getMessageById: () => assistantRow,
  getMessagesPaginated: (
    _conversationId: string,
    _limit: number | undefined,
    beforeTimestamp: number | undefined,
    filter?: (row: MessageRow) => boolean,
  ) => {
    const matches = userRows
      .filter(
        (row) => beforeTimestamp == null || row.createdAt < beforeTimestamp,
      )
      .filter((row) => !filter || filter(row));
    return { messages: matches.slice(-1), hasMore: false };
  },
}));

mock.module("../../persistence/conversation-attention-store.js", () => ({
  getAttentionStateByConversationIds: (ids: string[]) => {
    const map = new Map<string, AttentionState>();
    if (attentionState) {
      map.set(ids[0], attentionState);
    }
    return map;
  },
}));

const { emitAssistantReplyNotification } =
  await import("../assistant-reply-producer.js");

// ── Fixtures ───────────────────────────────────────────────────────────

const CONVERSATION_ID = "conv-1";
const ASSISTANT_MESSAGE_ID = "msg-assistant-1";

function makeConversation(
  overrides: Partial<ConversationRow> = {},
): ConversationRow {
  return {
    id: CONVERSATION_ID,
    title: "Weekend plans",
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalEstimatedCost: 0,
    contextSummary: null,
    contextCompactedMessageCount: 0,
    contextCompactedAt: null,
    historyStrippedAt: null,
    slackContextCompactionWatermarkTs: null,
    slackContextCompactionWatermarkAt: null,
    conversationType: "chat",
    source: "user",
    originChannel: null,
    originInterface: null,
    forkParentConversationId: null,
    forkParentMessageId: null,
    isAutoTitle: 0,
    scheduleJobId: null,
    lastMessageAt: null,
    archivedAt: null,
    surfacedAt: null,
    inferenceProfile: null,
    enabledPlugins: null,
    inferenceProfileSessionId: null,
    inferenceProfileExpiresAt: null,
    lastNotifiedInferenceProfile: null,
    processingStartedAt: null,
    ...overrides,
  };
}

function makeMessage(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: "msg-1",
    conversationId: CONVERSATION_ID,
    role: "user",
    content: [{ type: "text", text: "hello" }] as ContentBlock[],
    createdAt: 1700000000100,
    metadata: null,
    clientMessageId: null,
    finalized: 1,
    ...overrides,
  };
}

function makeAssistantRow(content: ContentBlock[]): MessageRow {
  return makeMessage({
    id: ASSISTANT_MESSAGE_ID,
    role: "assistant",
    content,
    createdAt: 1700000000200,
  });
}

function makeAttentionState(
  overrides: Partial<AttentionState> = {},
): AttentionState {
  return {
    conversationId: CONVERSATION_ID,
    latestAssistantMessageId: ASSISTANT_MESSAGE_ID,
    latestAssistantMessageAt: 1700000000200,
    lastSeenAssistantMessageId: null,
    lastSeenAssistantMessageAt: null,
    lastSeenEventAt: null,
    lastSeenConfidence: null,
    lastSeenSignalType: null,
    lastSeenSourceChannel: null,
    lastSeenSource: null,
    lastSeenEvidenceText: null,
    createdAt: 1700000000000,
    updatedAt: 1700000000200,
    ...overrides,
  };
}

const NON_USER_KIND_CASES: Array<{
  name: string;
  overrides: Partial<ConversationRow>;
}> = [
  { name: "background", overrides: { conversationType: "background" } },
  { name: "scheduled", overrides: { conversationType: "scheduled" } },
  {
    name: "memory-consolidation",
    overrides: { source: MEMORY_V2_CONSOLIDATION_SOURCE },
  },
];

const warnCalls: unknown[] = [];
const rlog = {
  warn: (...args: unknown[]) => {
    warnCalls.push(args);
  },
} as any;

async function run(): Promise<void> {
  await emitAssistantReplyNotification({
    conversationId: CONVERSATION_ID,
    assistantMessageId: ASSISTANT_MESSAGE_ID,
    rlog,
  });
}

beforeEach(() => {
  emitCalls.length = 0;
  warnCalls.length = 0;
  getConversationShouldThrow = false;
  conversationRow = makeConversation();
  assistantRow = makeAssistantRow([
    { type: "text", text: "Sure, here is the plan." },
  ] as ContentBlock[]);
  userRows = [makeMessage()];
  attentionState = makeAttentionState();
});

// ── Tests ──────────────────────────────────────────────────────────────

describe("emitAssistantReplyNotification", () => {
  test("emits one well-formed signal for an unseen user-conversation reply", async () => {
    await run();

    expect(emitCalls).toHaveLength(1);
    expect(emitCalls[0]).toEqual({
      sourceEventName: "chat.assistant_reply",
      sourceChannel: "vellum",
      sourceContextId: CONVERSATION_ID,
      attentionHints: {
        requiresAction: false,
        urgency: "medium",
        isAsyncBackground: false,
        visibleInSourceNow: false,
      },
      contextPayload: {
        requestedTitle: "Weekend plans",
        requestedMessage: "Sure, here is the plan.",
      },
      dedupeKey: `chat.assistant_reply:${CONVERSATION_ID}:${ASSISTANT_MESSAGE_ID}`,
    });
    // No conversation-creation fields: the platform channel is push-only.
    expect("requiresConversation" in emitCalls[0]).toBe(false);
    expect("conversationAffinityHint" in emitCalls[0]).toBe(false);
    expect("routingIntent" in emitCalls[0]).toBe(false);
  });

  test("omits requestedTitle when the conversation has no title", async () => {
    conversationRow = makeConversation({ title: "   " });

    await run();

    expect(emitCalls).toHaveLength(1);
    expect(emitCalls[0].contextPayload).toEqual({
      requestedMessage: "Sure, here is the plan.",
    });
  });

  test("collapses whitespace and caps the preview at 200 chars", async () => {
    assistantRow = makeAssistantRow([
      { type: "text", text: `${"a".repeat(300)}\n\n  b` },
    ] as ContentBlock[]);

    await run();

    const preview = emitCalls[0].contextPayload.requestedMessage as string;
    expect(preview).toHaveLength(200);
    expect(preview.endsWith("…")).toBe(true);
  });

  // Each case asserts the shared classifier's verdict alongside the silence, so
  // the gate is exercised through `resolveConversationKind` rather than through
  // a restatement of its branches.
  for (const { name, overrides } of NON_USER_KIND_CASES) {
    test(`stays silent for a ${name} conversation`, async () => {
      conversationRow = makeConversation(overrides);

      expect(
        resolveConversationKind(
          conversationRow.source,
          conversationRow.conversationType,
        ),
      ).not.toBe("user");

      await run();

      expect(emitCalls).toHaveLength(0);
    });
  }

  test("stays silent when the conversation is missing", async () => {
    conversationRow = null;

    await run();

    expect(emitCalls).toHaveLength(0);
  });

  test("stays silent when the initiating user message is automated", async () => {
    userRows = [makeMessage({ metadata: JSON.stringify({ automated: true }) })];

    await run();

    expect(emitCalls).toHaveLength(0);
  });

  // Hidden lifecycle rows persist with role "user" and are neither tool
  // results nor `automated`, so only the shared echo-suppression classifier
  // keeps a subagent or ACP completion turn from pushing a reply.
  const LIFECYCLE_ROW_CASES: Array<{ name: string; metadata: unknown }> = [
    {
      name: "subagent notification",
      metadata: {
        subagentNotification: {
          subagentId: "sub-1",
          label: "researcher",
          status: "running",
          conversationId: "conv-child-1",
          objective: "look something up",
        },
      },
    },
    {
      name: "ACP notification",
      metadata: { acpNotification: { acpSessionId: "acp-1", agent: "codex" } },
    },
  ];

  for (const { name, metadata } of LIFECYCLE_ROW_CASES) {
    test(`stays silent when the turn was opened by a ${name} row`, async () => {
      userRows = [makeMessage({ metadata: JSON.stringify(metadata) })];

      await run();

      expect(emitCalls).toHaveLength(0);
    });
  }

  // A voice utterance persists as an ordinary visible user row on a standard
  // conversation, so only the `voiceSessionTurn` marker the bridge stamps keeps
  // every spoken reply from also pushing. The phone case carries a `phone`
  // channel; the in-app live-voice case is `vellum`/`macos`, identical to a
  // typed desktop send, which is why the channel field cannot stand in for the
  // marker.
  const VOICE_ROW_CASES: Array<{ name: string; metadata: unknown }> = [
    {
      name: "phone call",
      metadata: {
        voiceSessionTurn: true,
        userMessageChannel: "phone",
        userMessageInterface: "phone",
      },
    },
    {
      name: "in-app live voice",
      metadata: {
        voiceSessionTurn: true,
        userMessageChannel: "vellum",
        userMessageInterface: "macos",
      },
    },
  ];

  for (const { name, metadata } of VOICE_ROW_CASES) {
    test(`stays silent when the turn was opened by a ${name} utterance`, async () => {
      userRows = [makeMessage({ metadata: JSON.stringify(metadata) })];

      await run();

      expect(emitCalls).toHaveLength(0);
    });
  }

  test("still emits for a typed desktop send on the same channel", async () => {
    userRows = [
      makeMessage({
        metadata: JSON.stringify({
          userMessageChannel: "vellum",
          userMessageInterface: "macos",
        }),
      }),
    ];

    await run();

    expect(emitCalls).toHaveLength(1);
  });

  // A channel turn's reply is delivered back to the originating surface, so the
  // sender already has it in Slack/Telegram; a push would be a second copy.
  for (const channel of ["slack", "telegram"] as const) {
    test(`stays silent for a turn opened from ${channel}`, async () => {
      userRows = [
        makeMessage({
          metadata: JSON.stringify({
            userMessageChannel: channel,
            assistantMessageChannel: channel,
          }),
        }),
      ];

      await run();

      expect(emitCalls).toHaveLength(0);
    });
  }

  // Rows predating the channel stamp (and the daemon paths that omit it) are
  // in-app turns, so an absent channel must not suppress the push.
  test("still emits when the initiating row carries no channel", async () => {
    userRows = [
      makeMessage({
        metadata: JSON.stringify({ userMessageInterface: "web" }),
      }),
    ];

    await run();

    expect(emitCalls).toHaveLength(1);
  });

  test("stays silent when no real user message opened the turn", async () => {
    userRows = [];

    await run();

    expect(emitCalls).toHaveLength(0);
  });

  test("skips tool-result rows when locating the initiating user message", async () => {
    userRows = [
      makeMessage({ id: "msg-user-1", createdAt: 1700000000100 }),
      makeMessage({
        id: "msg-tool-result-1",
        createdAt: 1700000000150,
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "done" },
        ] as ContentBlock[],
      }),
    ];

    await run();

    expect(emitCalls).toHaveLength(1);
  });

  test("stays silent when the reply is already seen", async () => {
    attentionState = makeAttentionState({
      lastSeenAssistantMessageId: ASSISTANT_MESSAGE_ID,
      lastSeenAssistantMessageAt: 1700000000200,
    });

    await run();

    expect(emitCalls).toHaveLength(0);
  });

  test("stays silent when there is no attention state row", async () => {
    attentionState = null;

    await run();

    expect(emitCalls).toHaveLength(0);
  });

  test("stays silent when the reply has no user-visible text", async () => {
    assistantRow = makeAssistantRow([
      { type: "tool_use", id: "t1", name: "bash", input: {} },
    ] as ContentBlock[]);

    await run();

    expect(emitCalls).toHaveLength(0);
  });

  test("stays silent when the assistant row is missing", async () => {
    assistantRow = null;

    await run();

    expect(emitCalls).toHaveLength(0);
  });

  test("never throws when a dependency throws", async () => {
    getConversationShouldThrow = true;

    await run();

    expect(emitCalls).toHaveLength(0);
    expect(warnCalls).toHaveLength(1);
  });
});

import { beforeEach, describe, expect, mock, test } from "bun:test";

import {
  createConversation,
  ensureConversationExists,
  getConversation,
} from "../persistence/conversation-crud.js";
import { getConversationByKey } from "../persistence/conversation-key-store.js";
import {
  isEchoSuppressedUserMessage,
  isReplyPushIneligibleUserMessage,
} from "../persistence/conversation-types.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { buildScopedConversationKey } from "../persistence/delivery-crud.js";
import { getBindingByConversation } from "../persistence/external-conversation-store.js";

await initializeDb();

// Capture the list-invalidation calls `runConversationTurn` fires when it
// creates a brand-new conversation row, without pulling in the real sync
// publisher (which reaches for live SSE subscribers).
const listChangedCalls: Array<{ kind: string; conversationId: string }> = [];
mock.module("../runtime/sync/resource-sync-events.js", () => ({
  publishConversationListAndMetadataChanged: (
    kind: string,
    conversationId: string,
  ) => {
    listChangedCalls.push({ kind, conversationId });
  },
}));

// Stub the heavy machinery: the in-memory conversation build (provider wiring,
// system prompt, history hydration) and the SSE event fan-out. The agent turn
// itself is a no-op — this test only asserts that the `conversations` row is
// persisted before the turn runs. The real `getOrCreateConversation` now
// creates the DB row before hydrating, so the mock mirrors that by calling
// `ensureConversationExists`. The persistence module is intentionally NOT
// mocked so the real `ensureConversationExists` runs against the real DB.
let lastProcessMessageConversationId: string | undefined;
let lastProcessMessageOptions: Record<string, unknown> | undefined;
let lastEnqueueOptions: Record<string, unknown> | undefined;
let lastTurnChannelContext: unknown;
let conversationIsProcessing = false;
mock.module("../daemon/conversation-store.js", () => ({
  getOrCreateConversation: async (
    conversationId: string,
    options?: { conversationType?: string },
  ) => {
    if (!getConversation(conversationId)) {
      if (options?.conversationType) {
        createConversation({
          id: conversationId,
          conversationType: options.conversationType as
            | "standard"
            | "background",
        });
      } else {
        ensureConversationExists(conversationId, "vellum");
      }
    }
    return {
      abortController: undefined,
      setTurnChannelContext: (ctx: unknown) => {
        lastTurnChannelContext = ctx;
      },
      isProcessing: () => conversationIsProcessing,
      async processMessage(processOptions: Record<string, unknown>) {
        // The row must already exist by the time the turn persists its user
        // message — record the id so the FK precondition can be asserted.
        lastProcessMessageConversationId = conversationId;
        lastProcessMessageOptions = processOptions;
        return "user-message-id";
      },
      enqueueMessage: (enqueueOptions: Record<string, unknown>) => {
        lastEnqueueOptions = enqueueOptions;
        return { rejected: false };
      },
    };
  },
}));

mock.module("../runtime/assistant-event-hub.js", () => ({
  broadcastMessage: () => {},
}));

mock.module("../providers/media-resolve.js", () => ({
  resolveMediaSourceData: () => null,
}));

// Import under test AFTER the mocks are registered so its dynamic imports
// resolve to the stubs above.
const { runConversationTurn } =
  await import("../plugin-api/conversation-turn.js");

describe("runConversationTurn persistence", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM messages");
    db.run("DELETE FROM conversations");
    listChangedCalls.length = 0;
    lastProcessMessageConversationId = undefined;
    lastProcessMessageOptions = undefined;
    lastEnqueueOptions = undefined;
    lastTurnChannelContext = undefined;
    conversationIsProcessing = false;
  });

  test("persists a conversations row for a freshly-minted conversation", async () => {
    const result = await runConversationTurn({
      content: [{ type: "text", text: "hello" }],
    });

    // The row exists on disk — not just as an in-memory Conversation object —
    // so the user-message persist inside the turn has its FK target.
    const row = getConversation(result.conversationId);
    expect(row?.id).toBe(result.conversationId);
    expect(lastProcessMessageConversationId).toBe(result.conversationId);

    // Siblings/sidebars are told about the new conversation, mirroring the
    // send-message route.
    expect(listChangedCalls).toEqual([
      { kind: "created", conversationId: result.conversationId },
    ]);
  });

  test("adopts a caller-supplied conversation id verbatim when no row exists", async () => {
    const conversationId = "0f9c1e2a-3b4d-5e6f-7a8b-9c0d1e2f3a4b";

    const result = await runConversationTurn({
      conversationId,
      content: [{ type: "text", text: "hello" }],
    });

    expect(result.conversationId).toBe(conversationId);
    expect(getConversation(conversationId)?.id).toBe(conversationId);
    expect(listChangedCalls).toEqual([{ kind: "created", conversationId }]);
  });

  test("is a no-op for an already-persisted conversation row", async () => {
    const existing = createConversation({ title: "already here" });
    listChangedCalls.length = 0;

    const result = await runConversationTurn({
      conversationId: existing.id,
      content: [{ type: "text", text: "follow up" }],
    });

    expect(result.conversationId).toBe(existing.id);
    // Row is untouched and no duplicate "created" invalidation fires.
    expect(getConversation(existing.id)?.title).toBe("already here");
    expect(listChangedCalls).toEqual([]);
  });
});

// A plugin drives its turn on its own schedule, so the row that opens it is
// machine-initiated even when the turn runs in an ordinary standard
// conversation the user also types into. Each case asserts the shared
// eligibility predicate's verdict on the stamped metadata, so the marker and
// the gate that reads it cannot drift apart.
describe("runConversationTurn provenance", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM messages");
    db.run("DELETE FROM conversations");
    lastProcessMessageOptions = undefined;
    lastEnqueueOptions = undefined;
    conversationIsProcessing = false;
  });

  test("stamps the initiating row automated so its reply raises no push", async () => {
    const existing = createConversation({ title: "standard conversation" });

    await runConversationTurn({
      conversationId: existing.id,
      content: [{ type: "text", text: "transcript excerpt" }],
    });

    const metadata = lastProcessMessageOptions?.metadata as Record<
      string,
      unknown
    >;
    expect(metadata).toEqual({ automated: true });
    expect(isReplyPushIneligibleUserMessage(metadata)).toBe(true);
    // Not an echo-suppression marker: the row still renders in the transcript.
    expect(isEchoSuppressedUserMessage(metadata)).toBe(false);
  });

  test("stamps the same marker on a turn queued behind a busy conversation", async () => {
    const existing = createConversation({ title: "busy conversation" });
    conversationIsProcessing = true;

    const result = await runConversationTurn({
      conversationId: existing.id,
      content: [{ type: "text", text: "transcript excerpt" }],
    });

    expect(result.queued).toBe(true);
    const metadata = lastEnqueueOptions?.metadata as Record<string, unknown>;
    expect(metadata).toEqual({ automated: true });
    expect(isReplyPushIneligibleUserMessage(metadata)).toBe(true);
  });
});

/**
 * Addressing a turn by chat rather than by conversation id.
 *
 * The point of these is not that the turn runs (that is the same code path
 * either way) but that the conversation it runs in is the one the rest of
 * the assistant already addresses by those coordinates. A caller keeping its
 * own chat-to-conversation map would pass every test above and still be
 * invisible to conversation reset, to the deny lanes, and to the channel
 * metadata the conversation list renders.
 */
describe("runConversationTurn channel binding", () => {
  const CHANNEL = {
    sourceChannel: "plugin" as const,
    externalChatId: "imessage:+12025550142",
    displayName: "Ada",
  };

  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM messages");
    db.run("DELETE FROM external_conversation_bindings");
    db.run("DELETE FROM conversation_keys");
    db.run("DELETE FROM conversations");
    listChangedCalls.length = 0;
    lastProcessMessageOptions = undefined;
    lastEnqueueOptions = undefined;
    lastTurnChannelContext = undefined;
    conversationIsProcessing = false;
  });

  test("resolves the chat to the conversation inbound would have used", async () => {
    const result = await runConversationTurn({
      channel: CHANNEL,
      content: [{ type: "text", text: "hello" }],
    });

    // The public name for this conversation, which is what reset and the deny
    // lanes address it by.
    expect(
      getConversationByKey(
        buildScopedConversationKey(
          CHANNEL.sourceChannel,
          CHANNEL.externalChatId,
        ),
      )?.conversationId,
    ).toBe(result.conversationId);
  });

  test("keeps the same chat in the same conversation across turns", async () => {
    const first = await runConversationTurn({
      channel: CHANNEL,
      content: [{ type: "text", text: "hello" }],
    });
    const second = await runConversationTurn({
      channel: CHANNEL,
      content: [{ type: "text", text: "still me" }],
    });

    expect(second.conversationId).toBe(first.conversationId);
    // Only the first turn minted a conversation.
    expect(listChangedCalls).toEqual([
      { kind: "created", conversationId: first.conversationId },
    ]);
  });

  test("gives a different chat its own conversation", async () => {
    const ada = await runConversationTurn({
      channel: CHANNEL,
      content: [{ type: "text", text: "hello" }],
    });
    const grace = await runConversationTurn({
      channel: { ...CHANNEL, externalChatId: "imessage:+12025550188" },
      content: [{ type: "text", text: "hello" }],
    });

    expect(grace.conversationId).not.toBe(ada.conversationId);
  });

  test("records the channel metadata the conversation list reads", async () => {
    const result = await runConversationTurn({
      channel: { ...CHANNEL, externalUserId: "+12025550142" },
      content: [{ type: "text", text: "hello" }],
    });

    const binding = getBindingByConversation(result.conversationId);
    expect(binding).toMatchObject({
      sourceChannel: "plugin",
      externalChatId: CHANNEL.externalChatId,
      externalUserId: "+12025550142",
      displayName: "Ada",
    });
  });

  test("follows the vendor when a display name changes", async () => {
    await runConversationTurn({
      channel: CHANNEL,
      content: [{ type: "text", text: "hello" }],
    });
    const result = await runConversationTurn({
      channel: { ...CHANNEL, displayName: "Ada L." },
      content: [{ type: "text", text: "renamed" }],
    });

    expect(getBindingByConversation(result.conversationId)?.displayName).toBe(
      "Ada L.",
    );
  });

  test("runs the turn on the channel it was addressed by", async () => {
    // Runtime assembly reads the per-turn channel first and only then the
    // conversation's origin, so a turn into a conversation whose origin was
    // never recorded would otherwise run as `vellum`. That is the wrong
    // channel for the message row and for the permission cascade the tools
    // are approved against.
    await runConversationTurn({
      channel: CHANNEL,
      content: [{ type: "text", text: "hello" }],
    });

    expect(lastTurnChannelContext).toEqual({
      userMessageChannel: "plugin",
      assistantMessageChannel: "plugin",
    });
    expect(lastProcessMessageOptions?.metadata).toMatchObject({
      userMessageChannel: "plugin",
      assistantMessageChannel: "plugin",
    });
  });

  test("a queued turn carries its own channel rather than inheriting one", async () => {
    // The drain happens after this call returns and reads the channel off the
    // queued message, falling back to whichever turn was in flight. On a
    // conversation shared with another channel that fallback is someone
    // else's channel.
    conversationIsProcessing = true;

    const result = await runConversationTurn({
      channel: CHANNEL,
      content: [{ type: "text", text: "hello" }],
    });

    expect(result.queued).toBe(true);
    expect(lastEnqueueOptions?.metadata).toMatchObject({
      userMessageChannel: "plugin",
      assistantMessageChannel: "plugin",
    });
  });

  test("leaves the channel unset when the turn names none", async () => {
    // Clearing rather than leaving whatever the last turn set: a stale
    // context would report this turn on a channel it has nothing to do with.
    await runConversationTurn({
      content: [{ type: "text", text: "hello" }],
    });

    expect(lastTurnChannelContext).toBeNull();
    expect(lastProcessMessageOptions?.metadata).toEqual({ automated: true });
  });

  test("keeps a known sender when a later turn omits it", async () => {
    // A plugin that knows only the chat coordinates this time is silent about
    // the sender, not asserting it has none. Erasing the stored name on that
    // silence drops it from the conversation and session APIs.
    await runConversationTurn({
      channel: { ...CHANNEL, externalUserId: "+12025550142" },
      content: [{ type: "text", text: "hello" }],
    });

    const result = await runConversationTurn({
      channel: {
        sourceChannel: CHANNEL.sourceChannel,
        externalChatId: CHANNEL.externalChatId,
      },
      content: [{ type: "text", text: "still me" }],
    });

    expect(getBindingByConversation(result.conversationId)).toMatchObject({
      externalUserId: "+12025550142",
      displayName: "Ada",
    });
  });

  test("clears a sender the caller explicitly says is gone", async () => {
    await runConversationTurn({
      channel: CHANNEL,
      content: [{ type: "text", text: "hello" }],
    });

    const result = await runConversationTurn({
      channel: { ...CHANNEL, displayName: null },
      content: [{ type: "text", text: "anonymous now" }],
    });

    expect(
      getBindingByConversation(result.conversationId)?.displayName,
    ).toBeNull();
  });

  test("an explicit conversation id wins over the address", async () => {
    // Two different conversations were named. Re-resolving would overrule the
    // caller, so the explicit one is honoured and nothing is bound behind it.
    const existing = createConversation({ title: "chosen" });

    const result = await runConversationTurn({
      conversationId: existing.id,
      channel: CHANNEL,
      content: [{ type: "text", text: "hello" }],
    });

    expect(result.conversationId).toBe(existing.id);
    expect(getBindingByConversation(existing.id)).toBeNull();
  });
});

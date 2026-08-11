/**
 * `runConversationTurn` against the real conversation store, the real agent
 * loop and the real database. The only thing stood in for is the provider's
 * HTTP boundary — `resolveProviderFromConnection` hands back a scripted mock
 * — so everything these tests read back (the `conversations` row, the user
 * message and the metadata stamped on it, the channel binding) is what
 * production wrote, not a stub mirroring what production is believed to do.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

import type { AssistantEvent } from "../api/index.js";
import { clearAllActiveConversations } from "../daemon/conversation-store.js";
import {
  conversationMetadataSyncTag,
  SYNC_TAGS,
} from "../daemon/message-types/sync.js";
import {
  createConversation,
  getConversation,
  getMessages,
  parseMessageMetadata,
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
import { createConnection } from "../providers/inference/connections.js";
import * as providerRegistry from "../providers/registry.js";
import type { Provider, ProviderResponse } from "../providers/types.js";
import { createMockProvider, textResponse } from "./helpers/mock-provider.js";
import { setConfig } from "./helpers/set-config.js";
import { waitFor } from "./helpers/wait-for.js";

await initializeDb();

// A conversation is built against the default provider, which resolves from
// config through a connection row. Both are seeded for real so the store takes
// the same path it takes in the daemon; only the provider the connection
// resolves to is scripted.
setConfig("llm", {
  profiles: {
    test: {
      provider: "anthropic",
      provider_connection: "test-conn",
      model: "claude-opus-4-6",
    },
  },
  activeProfile: "test",
});
setConfig("memory", { enabled: false, v2: { enabled: false } });

createConnection(getDb(), {
  name: "test-conn",
  provider: "anthropic",
  auth: { type: "api_key", credential: "credential/test/api_key" },
});

// The SSE fan-out is the one collaborator with nowhere to write in a test —
// every publish the turn makes (including the list invalidations asserted
// below, which reach clients through the real `resource-sync-events`) funnels
// through here.
const broadcasts: AssistantEvent[] = [];
mock.module(
  "../runtime/assistant-event-hub.js",
  (): Partial<typeof import("../runtime/assistant-event-hub.js")> => ({
    broadcastMessage: (msg: AssistantEvent) => {
      broadcasts.push(msg);
    },
  }),
);

const { provider: scriptedProvider } = createMockProvider([
  textResponse("scripted reply"),
]);

let gate: Promise<void> | undefined;
let releaseGate: (() => void) | undefined;

/**
 * Park the next turn inside the provider call until released, so a second turn
 * arrives while the conversation is genuinely processing rather than while a
 * stub reports that it is.
 */
function holdTheTurnOpen(): void {
  let resolveGate!: () => void;
  gate = new Promise<void>((resolve) => {
    resolveGate = resolve;
  });
  releaseGate = () => {
    gate = undefined;
    releaseGate = undefined;
    resolveGate();
  };
}

// A test that fails before releasing must not leave the next one parked on a
// gate it never opened.
afterEach(() => releaseGate?.());

const provider: Provider = {
  name: "scripted",
  async sendMessage(messages, options): Promise<ProviderResponse> {
    await gate;
    return scriptedProvider.sendMessage(messages, options);
  },
};

spyOn(providerRegistry, "resolveProviderFromConnection").mockResolvedValue(
  provider,
);

const { runConversationTurn } =
  await import("../plugin-api/conversation-turn.js");

/**
 * The list-level invalidations a turn published, as the tag sets clients
 * consume. Only a shape-changing reason carries the list umbrella tag, so a
 * reason that merely edits an existing row (a generated title) is excluded —
 * these are the announcements that a conversation appeared or vanished.
 */
function listInvalidations(): string[][] {
  return broadcasts
    .filter((msg) => msg.type === "sync_changed")
    .map((msg) => msg.tags)
    .filter((tags) => tags.includes(SYNC_TAGS.conversationsList));
}

/** The tag set `publishConversationListAndMetadataChanged` emits for a new row. */
function creationTags(conversationId: string): string[] {
  return [
    SYNC_TAGS.conversationsList,
    conversationMetadataSyncTag(conversationId),
  ];
}

/** User message rows of a conversation, oldest first. */
function userRows(conversationId: string) {
  return getMessages(conversationId).filter((row) => row.role === "user");
}

/** The metadata a turn persisted on a message row, parsed as consumers read it. */
function metadataOf(
  row: { metadata: string | null } | undefined,
): Record<string, unknown> | undefined {
  return parseMessageMetadata(row?.metadata ?? null);
}

function resetDb(): void {
  // In-memory conversations outlive the rows they were hydrated from, and a
  // reused id would otherwise hand the next test a Conversation whose
  // `conversations` row this wipe just deleted.
  clearAllActiveConversations();
  const db = getDb();
  db.run("DELETE FROM messages");
  db.run("DELETE FROM external_conversation_bindings");
  db.run("DELETE FROM conversation_keys");
  db.run("DELETE FROM conversations");
  broadcasts.length = 0;
}

describe("runConversationTurn persistence", () => {
  beforeEach(resetDb);

  test("persists a conversations row for a freshly-minted conversation", async () => {
    const result = await runConversationTurn({
      content: [{ type: "text", text: "hello" }],
    });

    // The row exists on disk — not just as an in-memory Conversation object —
    // and the user message the turn persisted found its FK target there.
    expect(getConversation(result.conversationId)?.id).toBe(
      result.conversationId,
    );
    expect(userRows(result.conversationId).map((row) => row.id)).toEqual([
      result.userMessageId,
    ]);

    // Siblings/sidebars are told about the new conversation, mirroring the
    // send-message route.
    expect(listInvalidations()).toEqual([creationTags(result.conversationId)]);
    expect(
      broadcasts.filter((msg) => msg.type === "conversation_list_invalidated"),
    ).toEqual([{ type: "conversation_list_invalidated", reason: "created" }]);
  });

  test("adopts a caller-supplied conversation id verbatim when no row exists", async () => {
    const conversationId = "0f9c1e2a-3b4d-5e6f-7a8b-9c0d1e2f3a4b";

    const result = await runConversationTurn({
      conversationId,
      content: [{ type: "text", text: "hello" }],
    });

    expect(result.conversationId).toBe(conversationId);
    expect(getConversation(conversationId)?.id).toBe(conversationId);
    expect(listInvalidations()).toEqual([creationTags(conversationId)]);
  });

  test("is a no-op for an already-persisted conversation row", async () => {
    const existing = createConversation({ title: "already here" });
    broadcasts.length = 0;

    const result = await runConversationTurn({
      conversationId: existing.id,
      content: [{ type: "text", text: "follow up" }],
    });

    expect(result.conversationId).toBe(existing.id);
    // Row is untouched and no duplicate "created" invalidation fires.
    expect(getConversation(existing.id)?.title).toBe("already here");
    expect(listInvalidations()).toEqual([]);
  });
});

// A plugin drives its turn on its own schedule, so the row that opens it is
// machine-initiated even when the turn runs in an ordinary standard
// conversation the user also types into. Each case asserts the shared
// eligibility predicate's verdict on the stamped metadata, so the marker and
// the gate that reads it cannot drift apart.
describe("runConversationTurn provenance", () => {
  beforeEach(resetDb);

  test("stamps the initiating row automated so its reply raises no push", async () => {
    const existing = createConversation({ title: "standard conversation" });

    const result = await runConversationTurn({
      conversationId: existing.id,
      content: [{ type: "text", text: "transcript excerpt" }],
    });

    // The scripted reply came back, so the marker below was stamped by a turn
    // that ran rather than by one that fell over into an error row.
    expect(result.content).toMatchObject([
      { type: "text", text: "scripted reply" },
    ]);

    const metadata = metadataOf(userRows(existing.id)[0]);
    expect(metadata).toMatchObject({ automated: true });
    expect(isReplyPushIneligibleUserMessage(metadata)).toBe(true);
    // Not an echo-suppression marker: the row still renders in the transcript.
    expect(isEchoSuppressedUserMessage(metadata)).toBe(false);
  });

  test("stamps the same marker on a turn queued behind a busy conversation", async () => {
    const existing = createConversation({ title: "busy conversation" });
    holdTheTurnOpen();

    const inFlight = runConversationTurn({
      conversationId: existing.id,
      content: [{ type: "text", text: "first excerpt" }],
    });
    await waitFor(() => userRows(existing.id).length === 1, {
      timeoutMs: 5_000,
      message: "the first turn never reached the provider",
    });

    const result = await runConversationTurn({
      conversationId: existing.id,
      content: [{ type: "text", text: "transcript excerpt" }],
    });
    expect(result.queued).toBe(true);

    // The queue drains after the in-flight turn releases, and the marker has
    // to survive that trip: it is stamped now but read off the persisted row
    // much later.
    releaseGate?.();
    await inFlight;
    await waitFor(() => userRows(existing.id).length === 2, {
      timeoutMs: 5_000,
      message: "the queued turn never drained",
    });

    const metadata = metadataOf(userRows(existing.id)[1]);
    expect(metadata).toMatchObject({ automated: true });
    expect(isReplyPushIneligibleUserMessage(metadata)).toBe(true);
  }, 20_000);
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

  beforeEach(resetDb);

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
    expect(listInvalidations()).toEqual([creationTags(first.conversationId)]);
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
    // channel for the message rows and for the permission cascade the tools
    // are approved against.
    const result = await runConversationTurn({
      channel: CHANNEL,
      content: [{ type: "text", text: "hello" }],
    });

    const rows = getMessages(result.conversationId);
    expect(metadataOf(rows[0])).toMatchObject({
      userMessageChannel: "plugin",
      assistantMessageChannel: "plugin",
    });
    expect(rows[1].role).toBe("assistant");
    expect(metadataOf(rows[1])).toMatchObject({
      userMessageChannel: "plugin",
      assistantMessageChannel: "plugin",
    });
  });

  test("a queued turn carries its own channel rather than inheriting one", async () => {
    // The drain happens after this call returns and reads the channel off the
    // queued message, falling back to whichever turn was in flight. Here that
    // fallback would be `vellum` — someone else's channel on a conversation
    // shared with another channel.
    const conversationId = "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d";
    holdTheTurnOpen();

    const inFlight = runConversationTurn({
      conversationId,
      content: [{ type: "text", text: "native turn" }],
    });
    await waitFor(() => userRows(conversationId).length === 1, {
      timeoutMs: 5_000,
      message: "the first turn never reached the provider",
    });

    const result = await runConversationTurn({
      conversationId,
      channel: CHANNEL,
      content: [{ type: "text", text: "hello" }],
    });
    expect(result.queued).toBe(true);

    releaseGate?.();
    await inFlight;
    await waitFor(() => userRows(conversationId).length === 2, {
      timeoutMs: 5_000,
      message: "the queued turn never drained",
    });

    expect(metadataOf(userRows(conversationId)[1])).toMatchObject({
      userMessageChannel: "plugin",
      assistantMessageChannel: "plugin",
    });
  }, 20_000);

  test("leaves the channel unset when the turn names none", async () => {
    // Clearing rather than leaving whatever the last turn set: a stale
    // context would report this turn on a channel it has nothing to do with.
    await runConversationTurn({
      channel: CHANNEL,
      content: [{ type: "text", text: "hello" }],
    });

    const result = await runConversationTurn({
      content: [{ type: "text", text: "hello" }],
    });

    const rows = getMessages(result.conversationId);
    const userMetadata = metadataOf(rows[0]);
    expect(userMetadata).toMatchObject({ automated: true });
    expect(userMetadata?.userMessageChannel).toBeUndefined();
    // The conversation carries no origin either, so the turn falls back to the
    // native channel rather than to the previous turn's.
    expect(metadataOf(rows[1])).toMatchObject({
      userMessageChannel: "vellum",
      assistantMessageChannel: "vellum",
    });
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

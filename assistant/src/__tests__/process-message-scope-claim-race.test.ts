/**
 * Two channel senders with different trust reaching the same idle
 * conversation at once.
 *
 * Scoping a turn's history awaits a reload. The first sender takes the
 * processing claim before it stamps its trust and reloads, so the second finds
 * the conversation busy and leaves the trust slot and the history alone,
 * instead of overwriting them while the first sender's reload is in flight.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

// What the real user-row insert answers, for tests that persist through it.
let insertOutcome: "insert" | "duplicate" | "throw" = "insert";
// Roles of the rows the real insert wrote, in order.
const insertedRoles: string[] = [];
// Holds the next user-row insert or slash resolution open when set.
let heldUserInsert: ReturnType<typeof createHold> | null = null;
let heldSlash: ReturnType<typeof createHold> | null = null;
let heldAssistantRetry: ReturnType<typeof createHold> | null = null;
// Conversations whose messages-changed invalidation went out, in order.
const messagesChangedPublishes: string[] = [];

mock.module("../persistence/attachments-store.js", () => ({
  getAttachmentsByIds: () => [],
  resolveAttachmentsForPersist: () => [],
}));

mock.module("../persistence/conversation-crud.js", () => ({
  setConversationProcessingStartedAt: () => {},
  isConversationProcessing: () => false,
  addMessage: async (
    _conversationId: string,
    role: string,
    _content: string,
    options?: { insertPrecondition?: () => boolean },
  ) => {
    if (options?.insertPrecondition && !options.insertPrecondition()) {
      throw new Error("insert precondition failed");
    }
    const hold = role === "user" ? heldUserInsert : null;
    if (hold) {
      heldUserInsert = null;
      await hold.wait();
    }
    // An assistant insert held here lost its first attempt to contention and
    // asks its precondition again before the retry, as the real insert does.
    const retry = role === "assistant" ? heldAssistantRetry : null;
    if (retry) {
      heldAssistantRetry = null;
      await retry.wait();
      if (options?.insertPrecondition && !options.insertPrecondition()) {
        throw new Error("insert precondition failed");
      }
    }
    insertedRoles.push(role);
    if (insertOutcome === "throw") {
      throw new Error("persist failed");
    }
    return { id: "persisted-id", deduplicated: insertOutcome === "duplicate" };
  },
  getConversation: () => null,
  getMessageById: () => null,
  provenanceFromTrustContext: () => ({}),
  setConversationOriginChannelIfUnset: () => {},
  setConversationOriginInterfaceIfUnset: () => {},
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
}));

mock.module("../persistence/conversation-disk-view.js", () => ({
  updateMetaFile: () => {},
}));

mock.module("../runtime/assistant-event-hub.js", () => ({
  broadcastMessage: () => {},
}));

mock.module("../daemon/conversation-runtime-assembly.js", () => ({
  resolveChannelCapabilities: () => ({
    channel: "slack",
    dashboardCapable: false,
    supportsDynamicUi: false,
    supportsVoiceInput: false,
    chatType: "channel",
  }),
}));

let activeConversation: ReturnType<typeof makeConversation>;

mock.module("../daemon/conversation-store.js", () => ({
  getOrCreateConversation: async () => activeConversation,
  mergeConversationOptions: () => {},
}));

import {
  acquireProcessingForActor,
  type ActorClaimContext,
  endPreparingClaim,
  isClaimLive,
  releasePreparingClaim,
} from "../daemon/conversation-actor-claim.js";
import { abortConversation } from "../daemon/conversation-lifecycle.js";
import {
  CONVERSATION_BUSY_MESSAGE,
  isConversationBusyError,
  type MessagingConversationContext,
  type PersistMessageOptions,
  persistUserMessage,
} from "../daemon/conversation-messaging.js";
import * as slashModule from "../daemon/conversation-slash.js";
import { processMessage } from "../daemon/process-message.js";
import type { TrustContext } from "../daemon/trust-context-types.js";
import * as syncEventsModule from "../runtime/sync/resource-sync-events.js";
import { createAbortReason } from "../util/abort-reasons.js";
import {
  createHold,
  createScopeRaceConversation,
  historyScopedFor,
} from "./helpers/scope-race-conversation.js";

// Mocked after the modules under test have loaded, so the real resolver is in
// hand to delegate to; the live binding is what those modules call.
const realSlash = { ...slashModule };
mock.module("../daemon/conversation-slash.js", () => ({
  ...realSlash,
  resolveSlash: async (
    ...args: Parameters<typeof realSlash.resolveSlash>
  ): ReturnType<typeof realSlash.resolveSlash> => {
    const hold = heldSlash;
    heldSlash = null;
    await hold?.wait();
    return realSlash.resolveSlash(...args);
  },
}));
const realSyncEvents = { ...syncEventsModule };
mock.module("../runtime/sync/resource-sync-events.js", () => ({
  ...realSyncEvents,
  publishConversationMessagesChanged: (
    ...args: Parameters<
      typeof realSyncEvents.publishConversationMessagesChanged
    >
  ) => {
    messagesChangedPublishes.push(args[0]);
    realSyncEvents.publishConversationMessagesChanged(...args);
  },
}));
import { setConfig } from "./helpers/set-config.js";

const CONV_ID = "conv-scope-claim-race";

const ALICE: TrustContext = {
  trustClass: "guardian",
  sourceChannel: "slack",
  guardianExternalUserId: "U-alice",
};
const BOB: TrustContext = {
  trustClass: "trusted_contact",
  sourceChannel: "slack",
  requesterExternalUserId: "U-bob",
};
// The actor the conversation rests at before either sender arrives.
const RESTING_OWNER: TrustContext = {
  trustClass: "guardian",
  sourceChannel: "slack",
};

function makeConversation() {
  const conversation = Object.assign(
    createScopeRaceConversation(CONV_ID, CONVERSATION_BUSY_MESSAGE, {
      isClaimLive,
      endPreparingClaim,
      releasePreparingClaim,
    }),
    {
      authContext: undefined,
      usageStats: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
      setAssistantId: () => {},
      setAuthContext: () => {},
      setChannelCapabilities: () => {},
      setHostCuProxy: () => {},
      setHostAppControlProxy: () => {},
      addPreactivatedSkillId: () => {},
      setCommandIntent: () => {},
      setTurnChannelContext: () => {},
      getTurnChannelContext: () => null,
      setTurnInterfaceContext: () => {},
      getTurnInterfaceContext: () => null,
      acquireProcessingForActor: (trust: TrustContext | null | undefined) =>
        acquireProcessingForActor(
          conversation as unknown as ActorClaimContext,
          trust,
        ),
      stop: () =>
        abortConversation(
          conversation as unknown as Parameters<typeof abortConversation>[0],
          createAbortReason("user_cancel", "test", CONV_ID),
        ),
    },
  );
  return conversation;
}

async function settled(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (err: unknown) => err,
  );
}

function send(content: string, trustContext: TrustContext) {
  return processMessage(CONV_ID, content, {
    trustContext,
    sourceChannel: "slack",
    sourceInterface: "slack",
  });
}

describe("channel ingress racing another sender to an idle conversation", () => {
  beforeEach(() => {
    setConfig("memory", { enabled: false, v2: { enabled: false } });
    activeConversation = makeConversation();
    insertOutcome = "insert";
    insertedRoles.length = 0;
    heldUserInsert = null;
    heldSlash = null;
    heldAssistantRetry = null;
    messagesChangedPublishes.length = 0;
  });

  test("the sender inside the history reload keeps its trust and history, and the other is turned away as busy", async () => {
    const conversation = activeConversation;
    const aliceReload = conversation.holdNextReload();

    const alice = send("from Alice", ALICE);
    await aliceReload.entered;

    // Bob arrives while Alice's reload is still in flight.
    const bobError = await settled(send("from Bob", BOB));
    expect(isConversationBusyError(bobError)).toBe(true);
    expect(conversation.trustContext).toBe(ALICE);
    expect(conversation.trustWrites).toEqual([ALICE]);

    aliceReload.release();
    await alice;

    expect(conversation.turns).toHaveLength(1);
    const [turn] = conversation.turns;
    expect(turn.trust).toBe(ALICE);
    expect(turn.historyAtStart).toEqual(historyScopedFor(ALICE));
    expect(turn.historyAtEnd).toEqual(historyScopedFor(ALICE));
    expect(conversation.persistedTrust).toEqual([ALICE]);
    expect(conversation.maxConcurrentTurns).toBe(1);
    expect(conversation.isProcessing()).toBe(false);
  });
  test("a Stop during the history reload cancels the claim instead of clearing it, and the message is turned away as busy", async () => {
    const conversation = activeConversation;
    const aliceReload = conversation.holdNextReload();

    const alice = settled(send("from Alice", ALICE));
    await aliceReload.entered;

    conversation.stop();
    // The claim is still held: Alice's reload has not settled, so nobody else
    // may acquire and reload over it.
    expect(conversation.isProcessing()).toBe(true);
    const bobError = await settled(send("from Bob", BOB));
    expect(isConversationBusyError(bobError)).toBe(true);
    expect(conversation.trustWrites).toEqual([ALICE]);

    aliceReload.release();
    // Alice's message takes the channel's busy path (deferred until idle and
    // retried) rather than starting a turn after the Stop.
    expect(isConversationBusyError(await alice)).toBe(true);
    expect(conversation.turns).toHaveLength(0);
    expect(conversation.persistedTrust).toEqual([]);
    // The claim is given back, the trust Alice stamped is put back, and the
    // queue is kicked for anything that arrived meanwhile.
    expect(conversation.isProcessing()).toBe(false);
    expect(conversation.trustContext).toBeUndefined();
    expect(conversation.drainKicks).toContain("actor_scope_cancelled");
  });
  test.each(["duplicate", "throw"] as const)(
    "a message queued behind the claim still runs when the persist answers %s",
    async (outcome) => {
      const conversation = activeConversation;
      conversation.trustContext = RESTING_OWNER;
      const aliceReload = conversation.holdNextReload();

      const alice = settled(send("from Alice", ALICE));
      await aliceReload.entered;
      // Bob's send lands on the queue while Alice holds the conversation.
      conversation.enqueue("from Bob");
      // Through the real persist, so the claim is handled as production
      // handles it when the insert answers a duplicate or throws.
      insertOutcome = outcome;
      conversation.persistUserMessage = (options) =>
        persistUserMessage(
          conversation as unknown as MessagingConversationContext,
          {
            content: "from Alice",
            ...(options as Omit<PersistMessageOptions, "content">),
          },
        );

      aliceReload.release();
      const result = await alice;
      if (outcome === "throw") {
        expect((result as Error).message).toBe("persist failed");
      } else {
        expect(result).toBeNull();
      }
      expect(conversation.turns).toHaveLength(0);
      expect(conversation.isProcessing()).toBe(false);
      expect(conversation.drained).toEqual(["from Bob"]);
      // A failed insert landed nothing, so the resting trust is put back; a
      // duplicate is a row this sender already wrote, so it stays theirs.
      expect(conversation.trustContext).toBe(
        outcome === "throw" ? RESTING_OWNER : ALICE,
      );
    },
  );
  test("a Stop during slash resolution turns the message away as busy and writes nothing", async () => {
    const conversation = activeConversation;
    conversation.trustContext = RESTING_OWNER;
    const slash = createHold();
    heldSlash = slash;

    const alice = settled(send("from Alice", ALICE));
    await slash.entered;
    conversation.stop();
    // Cancelled, not cleared: Bob still finds the conversation taken.
    expect(conversation.isProcessing()).toBe(true);
    expect(isConversationBusyError(await settled(send("from Bob", BOB)))).toBe(
      true,
    );

    slash.release();
    expect(isConversationBusyError(await alice)).toBe(true);
    expect(insertedRoles).toEqual([]);
    expect(conversation.persistedTrust).toEqual([]);
    expect(conversation.turns).toHaveLength(0);
    expect(conversation.isProcessing()).toBe(false);
    // Nothing of Alice's landed, so the conversation rests where it was.
    expect(conversation.trustContext).toBe(RESTING_OWNER);
  });

  test("a Stop during a slash command's user-row insert writes no reply", async () => {
    const conversation = activeConversation;
    const insert = createHold();
    heldUserInsert = insert;

    const alice = processMessage(CONV_ID, "/commands", {
      trustContext: ALICE,
      sourceChannel: "slack",
      sourceInterface: "slack",
    });
    await insert.entered;
    conversation.stop();
    expect(conversation.isProcessing()).toBe(true);
    expect(isConversationBusyError(await settled(send("from Bob", BOB)))).toBe(
      true,
    );

    insert.release();
    // The row the insert was already writing stays; nothing follows it.
    const result = await alice;
    expect(result.messageId).toBe("persisted-id");
    expect(result.assistantMessageId).toBeUndefined();
    expect(insertedRoles).toEqual(["user"]);
    // The row that landed is still finalized: seated in the resident history
    // and announced to other clients.
    expect(
      (conversation.messages as unknown[]).filter(
        (message) => (message as { role?: string }).role === "user",
      ),
    ).toHaveLength(1);
    expect(messagesChangedPublishes).toContain(CONV_ID);
    expect(conversation.turns).toHaveLength(0);
    expect(conversation.isProcessing()).toBe(false);
  });
  test("a Stop while a slash command's reply insert is retrying writes no reply", async () => {
    const conversation = activeConversation;
    const retry = createHold();
    heldAssistantRetry = retry;

    const alice = processMessage(CONV_ID, "/commands", {
      trustContext: ALICE,
      sourceChannel: "slack",
      sourceInterface: "slack",
    });
    await retry.entered;
    conversation.stop();
    expect(conversation.isProcessing()).toBe(true);

    retry.release();
    const result = await alice;
    expect(result.messageId).toBe("persisted-id");
    expect(result.assistantMessageId).toBeUndefined();
    expect(insertedRoles).toEqual(["user"]);
    // The row that landed is still finalized: seated in the resident history
    // and announced to other clients.
    expect(
      (conversation.messages as unknown[]).filter(
        (message) => (message as { role?: string }).role === "user",
      ),
    ).toHaveLength(1);
    expect(messagesChangedPublishes).toContain(CONV_ID);
    expect(conversation.turns).toHaveLength(0);
    expect(conversation.isProcessing()).toBe(false);
  });
  test("a queued message persisting after a cancelled reload is scoped for the restored owner", async () => {
    const conversation = activeConversation;
    const restingContact: TrustContext = {
      trustClass: "unknown",
      sourceChannel: "slack",
    };
    conversation.trustContext = restingContact;
    const aliceReload = conversation.holdNextReload();

    const alice = settled(send("from Alice", ALICE));
    await aliceReload.entered;
    conversation.stop();
    aliceReload.release();
    expect(isConversationBusyError(await alice)).toBe(true);
    // Alice's reload finished before the cancel was seen, so the resident
    // history is hers while the slot is back to the owner's.
    expect(conversation.trustContext).toBe(restingContact);
    expect(conversation.messages).toEqual(historyScopedFor(ALICE));

    // The queue drain persists without a claim, which scopes first.
    await conversation.persistUserMessage({
      trustContext: BOB,
      requestId: "queued-bob",
    });
    expect(conversation.messages).toEqual(historyScopedFor(restingContact));
  });
});

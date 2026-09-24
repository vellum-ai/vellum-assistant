/**
 * Two direct sends with different trust reaching the same idle conversation at
 * once through POST /v1/messages.
 *
 * Scoping a turn's history awaits a reload. The first send takes the
 * processing claim before it stamps its trust and reloads, so the second finds
 * the conversation busy and queues, as any send to a busy conversation does,
 * without overwriting the trust slot or the history while the first send's
 * reload is in flight.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

// What the real user-row insert answers, for tests that persist through it.
let insertOutcome: "insert" | "duplicate" | "throw" = "insert";
// Roles of the rows the real insert wrote, in order.
const insertedRoles: string[] = [];
// Holds the next user-row insert or slash resolution open when set.
let heldUserInsert: ReturnType<typeof createHold> | null = null;
let heldSlash: ReturnType<typeof createHold> | null = null;
let heldAssistantRetry: ReturnType<typeof createHold> | null = null;

mock.module("../config/env.js", () => ({ isHttpAuthDisabled: () => false }));

mock.module("../config/interrupt-on-send-gate.js", () => ({
  isInterruptOnSendEnabled: () => false,
}));

mock.module("../persistence/conversation-key-store.js", () => ({
  getOrCreateConversation: () => ({ conversationId: "conv-route-race" }),
  getConversationByKey: () => null,
}));

mock.module("../runtime/guardian-reply-router.js", () => ({
  routeGuardianReply: async () => ({
    consumed: false,
    decisionApplied: false,
    type: "not_consumed",
  }),
}));

mock.module("../channels/gateway-guardian-requests.js", () => ({
  createGuardianRequest: async (params: Record<string, unknown>) => ({
    ...params,
    requestCode: "ABC123",
  }),
}));

mock.module("../runtime/confirmation-request-guardian-bridge.js", () => ({
  bridgeConfirmationRequestToGuardian: async () => undefined,
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
  extractImageSourcePaths: () => undefined,
  getConversation: () => null,
  getConversationOverrideProfile: () => undefined,
  getMessages: () => [],
  isHiddenMessageMetadata: () => false,
  provenanceFromTrustContext: () => ({}),
  setConversationOriginChannelIfUnset: () => {},
  setConversationOriginInterfaceIfUnset: () => {},
  setConversationInferenceProfile: () => {},
  setConversationEnabledPlugins: () => {},
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
  recordConversationPersistedSeq: () => {},
}));

mock.module("../persistence/conversation-disk-view.js", () => ({
  syncMessageToDisk: () => {},
  updateMetaFile: () => {},
}));

mock.module("../persistence/attachments-store.js", () => ({
  getAttachmentsByIds: () => [],
  resolveAttachmentsForPersist: () => [],
  attachmentExists: () => false,
  linkAttachmentToMessage: () => {},
  attachInlineAttachmentToMessage: () => {},
  validateAttachmentUpload: () => ({ ok: true }),
}));

mock.module("../daemon/conversation-process.js", () => ({
  buildModelInfoEvent: () => null,
  isModelSlashCommand: () => false,
  formatCompactResult: () => "",
}));

const realLocalActorIdentity =
  await import("../runtime/local-actor-identity.js");
mock.module("../runtime/local-actor-identity.js", () => ({
  ...realLocalActorIdentity,
}));

const ALICE: TrustContext = {
  trustClass: "guardian",
  sourceChannel: "vellum",
  guardianPrincipalId: "alice-principal",
};
const BOB: TrustContext = {
  trustClass: "trusted_contact",
  sourceChannel: "vellum",
  requesterExternalUserId: "bob-principal",
};
const TRUST_BY_PRINCIPAL: Record<string, TrustContext> = {
  "alice-principal": ALICE,
  "bob-principal": BOB,
};

mock.module("../runtime/local-principal-trust.js", () => ({
  resolveLocalPrincipalTrustContext: async (input: {
    actorPrincipalId: string;
  }) => TRUST_BY_PRINCIPAL[input.actorPrincipalId],
}));

mock.module("../runtime/trust-context-resolver.js", () => ({
  resolveTrustContext: () => ALICE,
  withSourceChannel: (_sourceChannel: unknown, ctx: unknown) => ctx,
}));

mock.module("../contacts/guardian-delivery-reader.js", () => ({
  getGuardianDelivery: async () => [],
}));

mock.module("../ipc/gateway-client.js", () => ({
  ipcCall: async () => ({ ok: true }),
}));

import type { Conversation } from "../daemon/conversation.js";
import { acquireProcessingForActor } from "../daemon/conversation-actor-claim.js";
import { abortConversation } from "../daemon/conversation-lifecycle.js";
import {
  CONVERSATION_BUSY_MESSAGE,
  type MessagingConversationContext,
  persistUserMessage,
} from "../daemon/conversation-messaging.js";
import {
  deleteConversation,
  setConversation,
} from "../daemon/conversation-registry.js";
import * as slashModule from "../daemon/conversation-slash.js";
import type { TrustContext } from "../daemon/trust-context-types.js";
import { handleSendMessage } from "../runtime/routes/conversation-routes.js";
import { createAbortReason } from "../util/abort-reasons.js";
import { callHandler } from "./helpers/call-route-handler.js";
import { mockUnownedModeSessions } from "./helpers/mock-conversation.js";
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

const CONV_ID = "conv-route-race";

function makeConversation() {
  const enqueued: Array<{ content: string; trustContext?: TrustContext }> = [];
  const conversation = Object.assign(
    createScopeRaceConversation(CONV_ID, CONVERSATION_BUSY_MESSAGE),
    {
      enqueued,
      modeSessions: mockUnownedModeSessions(),
      queue: { length: 0 },
      inFlightSendRequestIds: new Map<string, string>(),
      usageStats: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
      assistantId: "self",
      pendingInterruptActivityBridge: false,
      replayActivityState: () => {},
      emitConfirmationStateChanged: () => {},
      emitActivityState: () => {},
      setTurnChannelContext: () => {},
      setTurnInterfaceContext: () => {},
      getTurnChannelContext: () => null,
      getTurnInterfaceContext: () => null,
      hasAnyPendingConfirmation: () => false,
      hasPendingConfirmation: () => false,
      denyAllPendingConfirmations: () => {},
      enqueueMessage: (options: {
        content: string;
        trustContext?: TrustContext;
      }) => {
        enqueued.push(options);
        conversation.enqueue(options.content);
        return { queued: true, requestId: "queued-id" };
      },
      setHostBrowserProxy: () => {},
      setHostCuProxy: () => {},
      setHostAppControlProxy: () => {},
      addPreactivatedSkillId: () => {},
      warmPromptCache: () => {},
      acquireProcessingForActor: (trust: TrustContext | null | undefined) =>
        acquireProcessingForActor(conversation, trust),
      stop: () =>
        abortConversation(
          conversation as unknown as Parameters<typeof abortConversation>[0],
          createAbortReason("user_cancel", "test", CONV_ID),
        ),
    },
  );
  return conversation;
}

function makeRequest(principalId: string, content: string) {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-vellum-actor-principal-id": principalId,
      "x-vellum-principal-type": "actor",
    },
    body: JSON.stringify({
      conversationKey: "route-race-key",
      content,
      sourceChannel: "vellum",
      interface: "macos",
    }),
  });
}

function send(
  conversation: ReturnType<typeof makeConversation>,
  principalId: string,
  content: string,
) {
  return callHandler(
    (args) =>
      handleSendMessage(args, {
        sendMessageDeps: {
          getOrCreateConversation: async () =>
            conversation as unknown as Conversation,
          assistantEventHub: { publish: async () => {} } as never,
          resolveAttachments: () => [],
        },
      }),
    makeRequest(principalId, content),
    undefined,
    202,
  );
}

afterEach(() => {
  deleteConversation(CONV_ID);
  insertOutcome = "insert";
  insertedRoles.length = 0;
  heldUserInsert = null;
  heldSlash = null;
  heldAssistantRetry = null;
});

describe("POST /v1/messages racing another sender to an idle conversation", () => {
  test("the send inside the history reload keeps its trust and history, and the other queues", async () => {
    const conversation = makeConversation();
    setConversation(CONV_ID, conversation as unknown as Conversation);
    const aliceReload = conversation.holdNextReload();

    const alice = send(conversation, "alice-principal", "from Alice");
    await aliceReload.entered;

    // Bob arrives while Alice's reload is still in flight.
    const bobResponse = await send(conversation, "bob-principal", "from Bob");
    expect(await bobResponse.json()).toMatchObject({
      accepted: true,
      queued: true,
    });
    expect(conversation.enqueued).toHaveLength(1);
    expect(conversation.enqueued[0].content).toBe("from Bob");
    expect(conversation.enqueued[0].trustContext).toBe(BOB);
    expect(conversation.trustContext).toBe(ALICE);
    expect(conversation.trustWrites).toEqual([ALICE]);

    aliceReload.release();
    const aliceResponse = await alice;
    expect(await aliceResponse.json()).toMatchObject({ accepted: true });

    while (conversation.isProcessing()) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(conversation.turns).toHaveLength(1);
    const [turn] = conversation.turns;
    expect(turn.trust).toBe(ALICE);
    expect(turn.historyAtStart).toEqual(historyScopedFor(ALICE));
    expect(turn.historyAtEnd).toEqual(historyScopedFor(ALICE));
    expect(conversation.persistedTrust).toEqual([ALICE]);
    expect(conversation.maxConcurrentTurns).toBe(1);
  });
  test("a Stop during the history reload cancels the claim instead of clearing it, and the message queues", async () => {
    const conversation = makeConversation();
    setConversation(CONV_ID, conversation as unknown as Conversation);
    const aliceReload = conversation.holdNextReload();

    const alice = send(conversation, "alice-principal", "from Alice");
    await aliceReload.entered;

    conversation.stop();
    // The claim is still held: Alice's reload has not settled, so nobody else
    // may acquire and reload over it.
    expect(conversation.isProcessing()).toBe(true);
    const bobResponse = await send(conversation, "bob-principal", "from Bob");
    expect(await bobResponse.json()).toMatchObject({ queued: true });
    expect(conversation.trustWrites).toEqual([ALICE]);

    aliceReload.release();
    // Alice's message is not dropped and does not start a turn after the Stop:
    // it queues behind Bob's, as a send to a busy conversation does, and runs
    // on the drain the released claim kicks.
    const aliceResponse = await alice;
    expect(await aliceResponse.json()).toMatchObject({
      accepted: true,
      queued: true,
    });
    expect(conversation.enqueued.map((item) => item.content)).toEqual([
      "from Bob",
      "from Alice",
    ]);
    expect(conversation.enqueued[1].trustContext).toBe(ALICE);
    expect(conversation.turns).toHaveLength(0);
    expect(conversation.persistedTrust).toEqual([]);
    expect(conversation.isProcessing()).toBe(false);
    expect(conversation.trustContext).toBeUndefined();
    expect(conversation.drainKicks).toContain("actor_scope_cancelled");
  });
  test.each(["duplicate", "throw"] as const)(
    "a send queued behind the claim still runs when the persist answers %s",
    async (outcome) => {
      const conversation = makeConversation();
      setConversation(CONV_ID, conversation as unknown as Conversation);
      const aliceReload = conversation.holdNextReload();

      const alice = send(conversation, "alice-principal", "from Alice").then(
        () => null,
        (err: unknown) => err,
      );
      await aliceReload.entered;
      const bobResponse = await send(conversation, "bob-principal", "from Bob");
      expect(await bobResponse.json()).toMatchObject({ queued: true });
      // Through the real persist, so the claim is handled as production
      // handles it when the insert answers a duplicate or throws.
      insertOutcome = outcome;
      conversation.persistUserMessage = (options) =>
        persistUserMessage(
          conversation as unknown as MessagingConversationContext,
          { content: "from Alice", ...options },
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
    },
  );
  test("a Stop during slash resolution queues the send and writes nothing", async () => {
    const conversation = makeConversation();
    setConversation(CONV_ID, conversation as unknown as Conversation);
    const slash = createHold();
    heldSlash = slash;

    const alice = send(conversation, "alice-principal", "from Alice");
    await slash.entered;
    conversation.stop();
    // Cancelled, not cleared: Bob still finds the conversation taken.
    expect(conversation.isProcessing()).toBe(true);
    const bobResponse = await send(conversation, "bob-principal", "from Bob");
    expect(await bobResponse.json()).toMatchObject({ queued: true });

    slash.release();
    expect(await (await alice).json()).toMatchObject({ queued: true });
    expect(insertedRoles).toEqual([]);
    expect(conversation.persistedTrust).toEqual([]);
    expect(conversation.turns).toHaveLength(0);
    expect(conversation.isProcessing()).toBe(false);
    expect(conversation.drained).toEqual(["from Bob", "from Alice"]);
  });

  test("a Stop during a slash command's user-row insert writes no reply", async () => {
    const conversation = makeConversation();
    setConversation(CONV_ID, conversation as unknown as Conversation);
    const insert = createHold();
    heldUserInsert = insert;

    const alice = send(conversation, "alice-principal", "/commands");
    await insert.entered;
    conversation.stop();
    expect(conversation.isProcessing()).toBe(true);
    const bobResponse = await send(conversation, "bob-principal", "from Bob");
    expect(await bobResponse.json()).toMatchObject({ queued: true });

    insert.release();
    // The row the insert was already writing stays; nothing follows it.
    const aliceBody = await (await alice).json();
    expect(aliceBody).toMatchObject({
      accepted: true,
      messageId: "persisted-id",
    });
    expect(aliceBody.queued).toBeUndefined();
    expect(insertedRoles).toEqual(["user"]);
    expect(conversation.turns).toHaveLength(0);
    expect(conversation.isProcessing()).toBe(false);
    expect(conversation.drained).toEqual(["from Bob"]);
  });
  test("a Stop while a slash command's reply insert is retrying writes no reply", async () => {
    const conversation = makeConversation();
    setConversation(CONV_ID, conversation as unknown as Conversation);
    const retry = createHold();
    heldAssistantRetry = retry;

    const alice = send(conversation, "alice-principal", "/commands");
    await retry.entered;
    conversation.stop();
    expect(conversation.isProcessing()).toBe(true);

    retry.release();
    const aliceBody = await (await alice).json();
    expect(aliceBody).toMatchObject({
      accepted: true,
      messageId: "persisted-id",
    });
    expect(insertedRoles).toEqual(["user"]);
    expect(conversation.turns).toHaveLength(0);
    expect(conversation.isProcessing()).toBe(false);
  });
});

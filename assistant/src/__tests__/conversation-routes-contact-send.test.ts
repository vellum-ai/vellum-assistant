/**
 * A shared-conversation contact's send runs through the one send pipeline
 * behind `POST /v1/messages`, with what a contact may not do gated off: it
 * queues behind a running turn instead of interrupting it, never answers or
 * supersedes the guardian's pending interactions, and runs as the contact
 * with its text fenced as untrusted input.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const CONV_ID = "conv-contact-send";
/** Rows already stored, by the key they were deduplicated under. */
const storedKeys = new Map<string, string>();

mock.module("../config/env.js", () => ({ isHttpAuthDisabled: () => true }));

mock.module("../persistence/conversation-key-store.js", () => ({
  getOrCreateConversation: () => ({ conversationId: "conv-hidden-queue" }),
  getConversationByKey: () => null,
}));

const routeGuardianReply = mock(async () => ({
  consumed: false,
  decisionApplied: false,
  type: "not_consumed",
}));
mock.module("../runtime/guardian-reply-router.js", () => ({
  routeGuardianReply,
}));

const extractPreferences = mock(async () => ({
  detected: false,
  preferences: [],
}));
const actualPreferenceExtractor =
  await import("../notifications/preference-extractor.js");
mock.module("../notifications/preference-extractor.js", () => ({
  ...actualPreferenceExtractor,
  extractPreferences,
}));

mock.module("../config/interrupt-on-send-gate.js", () => ({
  isInterruptOnSendEnabled: () => true,
}));

const broadcasts: Array<Record<string, unknown>> = [];
const actualHub = await import("../runtime/assistant-event-hub.js");
mock.module("../runtime/assistant-event-hub.js", () => ({
  ...actualHub,
  broadcastMessage: (msg: Record<string, unknown>) => {
    broadcasts.push(msg);
  },
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
  addMessage: async (_conversationId: string, role: string) => ({
    id: role === "user" ? "persisted-user-id" : "persisted-assistant-id",
    deduplicated: false,
  }),
  extractImageSourcePaths: () => undefined,
  getConversation: (id: string) =>
    id === CONV_ID ? { id, conversationType: "standard" } : null,
  hasMessages: () => true,
  findMessageIdByClientMessageId: (_conversationId: string, key: string) =>
    storedKeys.get(key),
  getConversationOverrideProfile: () => undefined,
  getMessages: () => [],
  isHiddenMessageMetadata: (meta: Record<string, unknown> | undefined) =>
    meta?.hidden === true,
  provenanceFromTrustContext: (ctx: unknown) =>
    ctx
      ? { provenanceTrustClass: (ctx as Record<string, unknown>).trustClass }
      : { provenanceTrustClass: "unknown" },
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
  buildModelInfoEvent: () => ({
    type: "model_info",
    model: "claude-opus-4-7",
    provider: "anthropic",
    configuredProviders: ["anthropic"],
  }),
  isModelSlashCommand: () => false,
  formatCompactResult: () => "",
}));

const realLocalActorIdentity =
  await import("../runtime/local-actor-identity.js");
mock.module("../runtime/local-actor-identity.js", () => ({
  ...realLocalActorIdentity,
}));

mock.module("../runtime/trust-context-resolver.js", () => ({
  resolveTrustContext: () => ({
    trustClass: "guardian",
    sourceChannel: "vellum",
  }),
  withSourceChannel: (sourceChannel: unknown, ctx: unknown) => ({
    ...(ctx as Record<string, unknown>),
    sourceChannel,
  }),
}));

mock.module("../contacts/guardian-delivery-reader.js", () => ({
  getGuardianDelivery: async () => [
    {
      channelType: "vellum",
      contactId: "guardian-contact",
      principalId: "test-user",
      address: "test-user",
      status: "active",
    },
  ],
}));

mock.module("../ipc/gateway-client.js", () => ({
  ipcCall: async () => ({ ok: true }),
}));

import type { Conversation } from "../daemon/conversation.js";
import {
  deleteConversation,
  setConversation,
} from "../daemon/conversation-registry.js";
import type { TrustContext } from "../daemon/trust-context-types.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";
import {
  type ContactSender,
  handleSendMessage,
} from "../runtime/routes/conversation-routes.js";
import { callHandler } from "./helpers/call-route-handler.js";
import { mockUnownedModeSessions } from "./helpers/mock-conversation.js";

const ALICE: TrustContext = {
  sourceChannel: "vellum-shared",
  trustClass: "trusted_contact",
  requesterExternalUserId: "principal-alice",
  requesterIdentifier: "principal-alice",
  requesterContactId: "contact-alice",
  guardianExternalUserId: "guardian-user",
};
const CONTACT: ContactSender = {
  trustContext: ALICE,
  principalId: "principal-alice",
};

interface Spies {
  conversation: Conversation;
  enqueued: () => Record<string, unknown> | undefined;
  persisted: () => Record<string, unknown> | undefined;
  loop: () =>
    | { content: string; options?: Record<string, unknown> }
    | undefined;
  denyAllCount: () => number;
  abortCount: () => number;
}

function makeConversation(opts: {
  processing: boolean;
  turnActor?: string;
  queueRejects?: boolean;
}): Spies {
  let enqueued: Record<string, unknown> | undefined;
  let persisted: Record<string, unknown> | undefined;
  let loop: { content: string; options?: Record<string, unknown> } | undefined;
  let denyAllCount = 0;
  let abortCount = 0;
  const conversation = {
    conversationId: CONV_ID,
    messages: [],
    abortController: {
      abort: () => {
        abortCount += 1;
      },
      signal: new AbortController().signal,
    },
    currentTurnSourceActorPrincipalId: opts.turnActor,
    inFlightSendRequestIds: new Map<string, string>(),
    currentRequestId: undefined,
    modeSessions: mockUnownedModeSessions(),
    queue: { length: 0, promoteToHead: (requestId: string) => ({ requestId }) },
    pendingSteerRepair: false,
    setTrustContext(this: { trustContext: unknown }, ctx: unknown) {
      this.trustContext = ctx;
    },
    replayActivityState: () => {},
    emitConfirmationStateChanged: () => {},
    emitActivityState: () => {},
    setTurnChannelContext: () => {},
    setTurnInterfaceContext: () => {},
    getTurnChannelContext: () => null,
    getTurnInterfaceContext: () => null,
    ensureActorScopedHistory: async () => {},
    isProcessing: () => opts.processing,
    setProcessing: () => {},
    hasAnyPendingConfirmation: () => true,
    denyAllPendingConfirmations: () => {
      denyAllCount += 1;
    },
    enqueueMessage: (options: Record<string, unknown>) => {
      enqueued = options;
      return opts.queueRejects
        ? { queued: false, requestId: "queued-id", rejected: true }
        : { queued: true, requestId: "queued-id" };
    },
    persistUserMessage: async (options: Record<string, unknown>) => {
      persisted = options;
      return { id: "persisted-user-id", deduplicated: false };
    },
    runAgentLoop: async (
      content: string,
      _messageId: string,
      options?: Record<string, unknown>,
    ) => {
      loop = { content, options };
    },
    setPreactivatedSkillIds: () => {},
    drainQueue: async () => {},
    kickDrainQueue: async () => {},
    warmPromptCache: () => {},
    getMessages: () => [{}],
    assistantId: "self",
    trustContext: undefined,
    hasPendingConfirmation: () => false,
    setHostBrowserProxy: () => {},
    setHostCuProxy: () => {},
    setHostAppControlProxy: () => {},
    addPreactivatedSkillId: () => {},
    usageStats: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
  } as unknown as Conversation;
  return {
    conversation,
    enqueued: () => enqueued,
    persisted: () => persisted,
    loop: () => loop,
    denyAllCount: () => denyAllCount,
    abortCount: () => abortCount,
  };
}

function makeRequest(content: string, clientMessageId?: string) {
  return new Request("http://localhost/v1/shared/conversations/x/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-vellum-actor-principal-id": "principal-alice",
      "x-vellum-principal-type": "actor",
    },
    body: JSON.stringify({
      conversationId: CONV_ID,
      content,
      sourceChannel: "vellum-shared",
      interface: "web",
      ...(clientMessageId ? { clientMessageId } : {}),
    }),
  });
}

async function sendAsContact(
  spies: Spies,
  content: string,
  clientMessageId?: string,
  sender: ContactSender = CONTACT,
) {
  setConversation(CONV_ID, spies.conversation);
  return callHandler(
    (args) =>
      handleSendMessage(args, {
        sendMessageDeps: {
          getOrCreateConversation: async () => spies.conversation,
          assistantEventHub: { publish: async () => {} } as never,
          resolveAttachments: () => [],
        },
        contactSender: sender,
      }),
    makeRequest(content, clientMessageId),
    undefined,
    202,
  );
}

const registeredRequestIds: string[] = [];

beforeEach(() => {
  const requestId = `pending-confirmation-${registeredRequestIds.length}`;
  pendingInteractions.register(requestId, {
    conversationId: CONV_ID,
    kind: "confirmation",
  });
  registeredRequestIds.push(requestId);
  routeGuardianReply.mockClear();
  extractPreferences.mockClear();
  broadcasts.length = 0;
  storedKeys.clear();
});

afterEach(() => {
  for (const id of registeredRequestIds) {
    pendingInteractions.resolve(id, "cancelled");
  }
  registeredRequestIds.length = 0;
  deleteConversation(CONV_ID);
});

describe("a contact's send into a busy conversation", () => {
  test("queues behind the running turn as the contact, fenced, without superseding", async () => {
    const spies = makeConversation({ processing: true });

    const res = await sendAsContact(spies, "Can we meet at noon?");

    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ accepted: true, queued: true });
    const enqueued = spies.enqueued()!;
    expect(enqueued.trustContext).toBe(ALICE);
    expect(enqueued.author).toBe(ALICE);
    expect(enqueued.sourceActorPrincipalId).toBe("principal-alice");
    expect(enqueued.displayContent).toBeUndefined();
    expect(enqueued.content).toContain("<external_content");
    expect(enqueued.content).toContain("Can we meet at noon?");
    expect(spies.denyAllCount()).toBe(0);
    expect(pendingInteractions.getByConversation(CONV_ID)).toHaveLength(1);
  });

  test.each([
    { label: "the guardian's", turnActor: "principal-bob" },
    { label: "the contact's own", turnActor: "principal-alice" },
    { label: "an unattributed", turnActor: undefined },
  ])("never interrupts $label running turn", async ({ turnActor }) => {
    const spies = makeConversation({ processing: true, turnActor });

    const res = await sendAsContact(spies, "Stop that");

    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ queued: true });
    expect(spies.abortCount()).toBe(0);
    expect(spies.enqueued()).toBeDefined();
  });

  test("a full queue answers the contact rather than dropping the message", async () => {
    const spies = makeConversation({ processing: true, queueRejects: true });

    const res = await sendAsContact(spies, "One more thing");

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ accepted: false, error: "queue_full" });
  });
});

describe("a contact's client message id", () => {
  const CAROL: ContactSender = {
    trustContext: {
      ...ALICE,
      requesterExternalUserId: "principal-carol",
      requesterIdentifier: "principal-carol",
      requesterContactId: "contact-carol",
    },
    principalId: "principal-carol",
  };

  test("reaches the client unchanged while the row is stored under a sender-scoped key", async () => {
    const spies = makeConversation({ processing: false });

    await sendAsContact(spies, "Hello", "nonce-1");

    expect(spies.persisted()?.clientMessageId).toBe(
      "vellum-shared:principal-alice:nonce-1",
    );
    expect(broadcasts).toContainEqual(
      expect.objectContaining({
        type: "user_message_echo",
        clientMessageId: "nonce-1",
      }),
    );
  });

  test("queues with the client's nonce for events and the scoped key for storage", async () => {
    const spies = makeConversation({ processing: true });

    await sendAsContact(spies, "Hello", "nonce-1");

    expect(spies.enqueued()).toMatchObject({
      clientMessageId: "nonce-1",
      storedClientMessageId: "vellum-shared:principal-alice:nonce-1",
    });
  });

  test("a retry from the same contact is answered from the stored row", async () => {
    storedKeys.set("vellum-shared:principal-alice:nonce-1", "row-alice");
    const spies = makeConversation({ processing: true });

    const res = await sendAsContact(spies, "Hello", "nonce-1");

    expect(await res.json()).toMatchObject({ messageId: "row-alice" });
    expect(spies.enqueued()).toBeUndefined();
  });

  test("another contact reusing the nonce is not deduplicated against it", async () => {
    storedKeys.set("vellum-shared:principal-alice:nonce-1", "row-alice");
    const spies = makeConversation({ processing: true });

    const res = await sendAsContact(spies, "Hello", "nonce-1", CAROL);

    expect(await res.json()).toMatchObject({ queued: true });
    expect(spies.enqueued()).toMatchObject({
      clientMessageId: "nonce-1",
      storedClientMessageId: "vellum-shared:principal-carol:nonce-1",
    });
  });
});

describe("a contact's send into an idle conversation", () => {
  test("runs the turn as the contact and leaves the guardian's interactions alone", async () => {
    const spies = makeConversation({ processing: false });

    const res = await sendAsContact(spies, "Can we meet at noon?");

    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      accepted: true,
      messageId: "persisted-user-id",
    });
    // Stored fenced, so the fence survives a reload of the conversation.
    expect(spies.persisted()).toMatchObject({ author: ALICE });
    expect(spies.persisted()?.displayContent).toBeUndefined();
    expect(spies.persisted()?.content).toContain("<external_content");
    const loop = spies.loop()!;
    expect(loop.content).toContain("<external_content");
    expect(loop.options?.turnTrustContext).toBe(ALICE);
    expect(spies.denyAllCount()).toBe(0);
    expect(routeGuardianReply).not.toHaveBeenCalled();
    expect(extractPreferences).not.toHaveBeenCalled();
    expect(
      (
        spies.conversation as unknown as {
          currentTurnSourceActorPrincipalId?: string;
        }
      ).currentTurnSourceActorPrincipalId,
    ).toBe("principal-alice");
    expect(broadcasts).toContainEqual(
      expect.objectContaining({
        type: "user_message_echo",
        text: "Can we meet at noon?",
      }),
    );
  });

  test("a slash command from a contact is message text, not a command", async () => {
    const spies = makeConversation({ processing: false });

    const res = await sendAsContact(spies, "/model fast");

    expect(res.status).toBe(202);
    expect(spies.persisted()?.content).toContain("/model fast");
    expect(spies.loop()?.content).toContain("<external_content");
  });

  test("the row is stored as the contact even when the guardian takes the slot meanwhile", async () => {
    const spies = makeConversation({ processing: false });
    const conversation = spies.conversation as unknown as {
      trustContext?: TrustContext;
      persistUserMessage: (
        options: Record<string, unknown>,
      ) => Promise<{ id: string; deduplicated: boolean }>;
    };
    let storedTrustClass: string | undefined;
    conversation.persistUserMessage = async (options) => {
      // An overlapping guardian send stamps the slot before this row lands.
      conversation.trustContext = {
        trustClass: "guardian",
        sourceChannel: "vellum",
      };
      // The row's provenance, resolved the way the persist resolves it.
      storedTrustClass = (
        (options.trustContext as TrustContext | undefined) ??
        conversation.trustContext
      ).trustClass;
      return { id: "persisted-user-id", deduplicated: false };
    };

    await sendAsContact(spies, "Hello");

    expect(storedTrustClass).toBe("trusted_contact");
  });
});

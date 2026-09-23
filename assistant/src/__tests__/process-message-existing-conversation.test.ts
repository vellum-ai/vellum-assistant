/**
 * A turn started for a sender who may write into a conversation but never
 * create one: `existingConversationOnly` joins a live conversation or refuses,
 * the sender's trust rides the persisted row and the turn even if the
 * conversation's slot is rewritten meanwhile, and the turn's actor is the
 * sender, so a desktop registered to someone else is never attached.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

let desktopClients: { actorPrincipalId?: string }[] = [];

const actualHub = await import("../runtime/assistant-event-hub.js");
mock.module("../runtime/assistant-event-hub.js", () => ({
  ...actualHub,
  broadcastMessage: () => {},
  assistantEventHub: {
    listClientsByCapability: () => desktopClients,
  },
}));

interface StubConversation {
  conversationId: string;
  trustContext: unknown;
  authContext: unknown;
  currentTurnSourceActorPrincipalId: string | undefined;
  hostCuProxy: unknown;
  hostAppControlProxy: unknown;
  isProcessing: () => boolean;
  setAssistantId: () => void;
  setTrustContext: (ctx: unknown) => void;
  setAuthContext: (ctx: unknown) => void;
  ensureActorScopedHistory: () => Promise<void>;
  setChannelCapabilities: () => void;
  setHostCuProxy: (proxy: unknown) => void;
  setHostAppControlProxy: (proxy: unknown) => void;
  addPreactivatedSkillId: () => void;
  setCommandIntent: () => void;
  setTurnChannelContext: () => void;
  setTurnInterfaceContext: () => void;
  persistUserMessage: ReturnType<
    typeof mock<
      (options: Record<string, unknown>) => Promise<{
        id: string;
        deduplicated: boolean;
      }>
    >
  >;
  runAgentLoop: ReturnType<typeof mock<(...args: unknown[]) => Promise<void>>>;
}

const ALICE_TRUST = {
  sourceChannel: "vellum-shared",
  trustClass: "trusted_contact",
  requesterExternalUserId: "principal-alice",
  requesterContactId: "contact-alice",
};
const GUARDIAN_TRUST = { sourceChannel: "vellum", trustClass: "guardian" };

function makeConversation(): StubConversation {
  const conversation: StubConversation = {
    conversationId: "conv-shared",
    trustContext: undefined,
    authContext: undefined,
    currentTurnSourceActorPrincipalId: "principal-bob",
    hostCuProxy: undefined,
    hostAppControlProxy: undefined,
    isProcessing: () => false,
    setAssistantId: () => {},
    setTrustContext: (ctx) => {
      conversation.trustContext = ctx;
    },
    setAuthContext: (ctx) => {
      conversation.authContext = ctx;
    },
    ensureActorScopedHistory: async () => {},
    setChannelCapabilities: () => {},
    setHostCuProxy: (proxy) => {
      conversation.hostCuProxy = proxy;
    },
    setHostAppControlProxy: (proxy) => {
      conversation.hostAppControlProxy = proxy;
    },
    addPreactivatedSkillId: () => {},
    setCommandIntent: () => {},
    setTurnChannelContext: () => {},
    setTurnInterfaceContext: () => {},
    persistUserMessage: mock(async () => {
      // Another sender stamps the resting slot while this one persists.
      conversation.trustContext = GUARDIAN_TRUST;
      return { id: "user-message-id", deduplicated: false };
    }),
    runAgentLoop: mock(async () => {}),
  };
  return conversation;
}

let conversation: StubConversation | null;
const getOrCreateConversation = mock(async () => conversation);
const getConversationIfExists = mock(async () => conversation);

const actualStore = await import("../daemon/conversation-store.js");
mock.module("../daemon/conversation-store.js", () => ({
  ...actualStore,
  getOrCreateConversation,
  getConversationIfExists,
  mergeConversationOptions: () => {},
}));

const { ConversationNotFoundError, processMessageInBackground } =
  await import("../daemon/process-message.js");

const SHARED_OPTIONS = {
  existingConversationOnly: true,
  sourceChannel: "vellum-shared",
  sourceInterface: "web",
  trustContext: ALICE_TRUST,
  author: ALICE_TRUST,
  sourceActorPrincipalId: "principal-alice",
} as unknown as Parameters<typeof processMessageInBackground>[2];

beforeEach(() => {
  conversation = makeConversation();
  desktopClients = [];
  getOrCreateConversation.mockClear();
  getConversationIfExists.mockClear();
});

describe("processMessageInBackground for an existing conversation", () => {
  test("refuses a missing conversation without creating it", async () => {
    conversation = null;

    await expect(
      processMessageInBackground("conv-missing", "Hello", SHARED_OPTIONS),
    ).rejects.toBeInstanceOf(ConversationNotFoundError);

    expect(getConversationIfExists).toHaveBeenCalledTimes(1);
    expect(getOrCreateConversation).not.toHaveBeenCalled();
  });

  test("joins an existing conversation through the non-creating acquire", async () => {
    await processMessageInBackground("conv-shared", "Hello", SHARED_OPTIONS);

    expect(getConversationIfExists).toHaveBeenCalledTimes(1);
    expect(getOrCreateConversation).not.toHaveBeenCalled();
    expect(conversation!.runAgentLoop).toHaveBeenCalledTimes(1);
  });

  test("the sender's trust rides the row and the turn after the slot moves", async () => {
    await processMessageInBackground("conv-shared", "Hello", SHARED_OPTIONS);

    const persisted = conversation!.persistUserMessage.mock.calls[0][0];
    expect(persisted.trustContext).toBe(ALICE_TRUST);
    expect(persisted.author).toBe(ALICE_TRUST);
    expect(conversation!.trustContext).toBe(GUARDIAN_TRUST);
    expect(conversation!.runAgentLoop.mock.calls[0][2]).toEqual(
      expect.objectContaining({ turnTrustContext: ALICE_TRUST }),
    );
  });

  test("the turn runs as the sender and never attaches another actor's desktop", async () => {
    desktopClients = [{ actorPrincipalId: "principal-bob" }];

    await processMessageInBackground("conv-shared", "Hello", SHARED_OPTIONS);

    expect(conversation!.currentTurnSourceActorPrincipalId).toBe(
      "principal-alice",
    );
    expect(conversation!.hostCuProxy).toBeUndefined();
    expect(conversation!.hostAppControlProxy).toBeUndefined();
  });

  test("a caller that names no actor leaves the turn actor alone", async () => {
    await processMessageInBackground("conv-shared", "Hello", {
      sourceChannel: "vellum",
      sourceInterface: "web",
    });

    expect(getOrCreateConversation).toHaveBeenCalledTimes(1);
    expect(conversation!.currentTurnSourceActorPrincipalId).toBe(
      "principal-bob",
    );
    expect(conversation!.runAgentLoop.mock.calls[0][2]).not.toHaveProperty(
      "turnTrustContext",
    );
  });
});

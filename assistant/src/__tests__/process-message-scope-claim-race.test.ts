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

mock.module("../persistence/attachments-store.js", () => ({
  getAttachmentsByIds: () => [],
  resolveAttachmentsForPersist: () => [],
}));

mock.module("../persistence/conversation-crud.js", () => ({
  setConversationProcessingStartedAt: () => {},
  isConversationProcessing: () => false,
  addMessage: async () => ({ id: "message-id" }),
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

import { isConversationBusyError } from "../daemon/conversation-messaging.js";
import { processMessage } from "../daemon/process-message.js";
import type { TrustContext } from "../daemon/trust-context-types.js";
import {
  createScopeRaceConversation,
  historyScopedFor,
} from "./helpers/scope-race-conversation.js";
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

function makeConversation() {
  return Object.assign(createScopeRaceConversation(CONV_ID), {
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
  });
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
  });

  test("the sender inside the history reload keeps its trust and history, and the other is turned away as busy", async () => {
    const conversation = activeConversation;
    const aliceReload = conversation.holdNextReload();

    const alice = send("from Alice", ALICE);
    await aliceReload.entered;

    // Bob arrives while Alice's reload is still in flight.
    const bobError = await send("from Bob", BOB).then(
      () => null,
      (err: unknown) => err,
    );
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
});

/**
 * POST /v1/messages rejects sends into a conversation whose processing flag is
 * stuck (marked busy with no live turn to ever drain the queue — ATL-1009).
 * Instead of enqueuing behind a dead turn (202) and letting the client time
 * out with a misleading "Assistant did not respond in time.", the handler
 * returns 409 with `details.reason: "conversation_stuck"` so the client can
 * offer a recoverable path (ATL-1010).
 *
 * A genuinely busy conversation (a live turn is running) still queues with 202,
 * and hidden machine-signal sends skip the stuck check entirely.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

mock.module("../config/env.js", () => ({ isHttpAuthDisabled: () => true }));

mock.module("../persistence/conversation-key-store.js", () => ({
  getOrCreateConversation: () => ({ conversationId: "conv-stuck" }),
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
  isConversationProcessing: () => true,
  addMessage: async (_conversationId: string, role: string) => ({
    id: role === "user" ? "persisted-user-id" : "persisted-assistant-id",
    deduplicated: false,
  }),
  extractImageSourcePaths: () => undefined,
  getConversation: () => null,
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
  getSourcePathsForAttachments: () => new Map(),
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
import { handleSendMessage } from "../runtime/routes/conversation-routes.js";
import { callHandler } from "./helpers/call-route-handler.js";

const CONV_ID = "conv-stuck";

interface ConversationSpies {
  conversation: Conversation;
  enqueueCount: () => number;
}

function makeConversation(opts: { stuck: boolean }): ConversationSpies {
  let enqueueCount = 0;
  const conversation = {
    conversationId: CONV_ID,
    messages: [],
    abortController: null,
    currentRequestId: undefined,
    queue: { length: 0 },
    setTrustContext: () => {},
    updateClient: () => {},
    emitConfirmationStateChanged: () => {},
    emitActivityState: () => {},
    setTurnChannelContext: () => {},
    setTurnInterfaceContext: () => {},
    ensureActorScopedHistory: async () => {},
    isProcessing: () => true,
    isProcessingStuck: () => opts.stuck,
    setProcessing: () => {},
    hasAnyPendingConfirmation: () => false,
    denyAllPendingConfirmations: () => {},
    enqueueMessage: () => {
      enqueueCount += 1;
      return { queued: true, requestId: "queued-id" };
    },
    setPreactivatedSkillIds: () => {},
    drainQueue: async () => {},
    warmPromptCache: () => {},
    getMessages: () => [],
    assistantId: "self",
    trustContext: undefined,
    hasPendingConfirmation: () => false,
    setHostBrowserProxy: () => {},
    setHostCuProxy: () => {},
    setHostAppControlProxy: () => {},
    addPreactivatedSkillId: () => {},
    usageStats: { inputTokens: 1000, outputTokens: 500, estimatedCost: 0.05 },
  } as unknown as Conversation;
  return { conversation, enqueueCount: () => enqueueCount };
}

function makeRequest(extras: Record<string, unknown> = {}) {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-vellum-actor-principal-id": "test-user",
      "x-vellum-principal-type": "actor",
    },
    body: JSON.stringify({
      conversationKey: "stuck-key",
      content: "are you there?",
      sourceChannel: "vellum",
      interface: "macos",
      ...extras,
    }),
  });
}

function makeDeps(conversation: Conversation) {
  return {
    sendMessageDeps: {
      getOrCreateConversation: async () => conversation,
      assistantEventHub: { publish: async () => {} } as never,
      resolveAttachments: () => [],
    },
  };
}

afterEach(() => {
  deleteConversation(CONV_ID);
});

describe("POST /v1/messages into a stuck conversation", () => {
  test("returns 409 with reason conversation_stuck instead of enqueuing", async () => {
    const spies = makeConversation({ stuck: true });
    setConversation(CONV_ID, spies.conversation);

    const res = await callHandler(
      (args) => handleSendMessage(args, makeDeps(spies.conversation)),
      makeRequest(),
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { code: string; details?: { reason?: string } };
    };
    expect(body.error.details?.reason).toBe("conversation_stuck");
    // The wedged message was rejected, never enqueued behind the dead turn.
    expect(spies.enqueueCount()).toBe(0);
  });

  test("a genuinely busy conversation still queues with 202", async () => {
    const spies = makeConversation({ stuck: false });
    setConversation(CONV_ID, spies.conversation);

    const res = await callHandler(
      (args) => handleSendMessage(args, makeDeps(spies.conversation)),
      makeRequest(),
      undefined,
      202,
    );

    expect(res.status).toBe(202);
    expect(spies.enqueueCount()).toBe(1);
  });

  test("hidden machine-signal sends skip the stuck check and queue", async () => {
    const spies = makeConversation({ stuck: true });
    setConversation(CONV_ID, spies.conversation);

    const res = await callHandler(
      (args) => handleSendMessage(args, makeDeps(spies.conversation)),
      makeRequest({ hidden: true }),
      undefined,
      202,
    );

    expect(res.status).toBe(202);
    expect(spies.enqueueCount()).toBe(1);
  });
});

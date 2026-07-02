/**
 * Queue-branch contract for hidden sends in POST /v1/messages.
 *
 * A hidden send is a machine signal (e.g. the channel-setup wizard-close
 * marker), not a user decision — when it queues behind an in-flight turn it
 * must NOT supersede pending interactions: no auto-denied confirmations, no
 * steer of a parked ask_question. A visible send in the same state keeps the
 * existing supersede behavior ("the user chose to move on").
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

mock.module("../config/env.js", () => ({ isHttpAuthDisabled: () => true }));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    model: "claude-opus-4-7",
    provider: "anthropic",
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0 },
    secretDetection: { enabled: false },
    contextWindow: { maxInputTokens: 200000 },
    llm: {
      default: {
        provider: "anthropic",
        model: "claude-opus-4-7",
        maxTokens: 64000,
        effort: "max" as const,
        speed: "standard" as const,
        temperature: null,
        thinking: { enabled: true, streamThinking: true },
        contextWindow: {
          enabled: true,
          maxInputTokens: 200000,
          targetBudgetRatio: 0.3,
          compactThreshold: 0.8,
          summaryBudgetRatio: 0.05,
        },
      },
      profiles: {},
      callSites: {},
      pricingOverrides: [],
    },
    services: {
      inference: {
        mode: "your-own",
        provider: "anthropic",
        model: "claude-opus-4-7",
      },
      "image-generation": {
        mode: "your-own",
        provider: "gemini",
        model: "gemini-3.1-flash-image-preview",
      },
      "web-search": { mode: "your-own", provider: "inference-provider-native" },
    },
  }),
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../persistence/conversation-key-store.js", () => ({
  getOrCreateConversation: () => ({ conversationId: "conv-hidden-queue" }),
  getConversationByKey: () => null,
}));

mock.module("../runtime/guardian-reply-router.js", () => ({
  routeGuardianReply: async () => ({
    consumed: false,
    decisionApplied: false,
    type: "not_consumed",
  }),
}));

mock.module("../contacts/canonical-guardian-store.js", () => ({
  createCanonicalGuardianRequest: () => ({
    id: "canonical-id",
    requestCode: "ABC123",
  }),
  generateCanonicalRequestCode: () => "ABC123",
  listPendingCanonicalGuardianRequestsByDestinationConversation: () => [],
  listCanonicalGuardianRequests: () => [],
  listPendingRequestsByConversationScope: () => [],
  resolveCanonicalGuardianRequest: () => undefined,
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

mock.module("../runtime/local-actor-identity.js", () => ({
  resolveLocalTrustContext: () => ({
    trustClass: "guardian",
    sourceChannel: "vellum",
  }),
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
import * as pendingInteractions from "../runtime/pending-interactions.js";
import { handleSendMessage } from "../runtime/routes/conversation-routes.js";
import { callHandler } from "./helpers/call-route-handler.js";

const CONV_ID = "conv-hidden-queue";

interface BusyConversationSpies {
  conversation: Conversation;
  enqueuedMetadata: () => Record<string, unknown> | undefined;
  denyAllCount: () => number;
  abortCount: () => number;
}

/** A live, mid-turn conversation with a pending tool confirmation. */
function makeBusyConversation(): BusyConversationSpies {
  let enqueuedMetadata: Record<string, unknown> | undefined;
  let denyAllCount = 0;
  let abortCount = 0;
  const conversation = {
    conversationId: CONV_ID,
    messages: [],
    abortController: {
      abort: () => {
        abortCount += 1;
      },
    },
    currentRequestId: undefined,
    queue: {
      length: 0,
      promoteToHead: (requestId: string) => ({ requestId }),
    },
    pendingSteerRepair: false,
    setTrustContext: () => {},
    updateClient: () => {},
    emitConfirmationStateChanged: () => {},
    emitActivityState: () => {},
    setTurnChannelContext: () => {},
    setTurnInterfaceContext: () => {},
    getTurnChannelContext: () => null,
    getTurnInterfaceContext: () => null,
    ensureActorScopedHistory: async () => {},
    isProcessing: () => true,
    setProcessing: () => {},
    hasAnyPendingConfirmation: () => true,
    denyAllPendingConfirmations: () => {
      denyAllCount += 1;
    },
    enqueueMessage: (options: { metadata?: Record<string, unknown> }) => {
      enqueuedMetadata = options.metadata;
      return { queued: true, requestId: "queued-id" };
    },
    persistUserMessage: async () => ({
      id: "persisted-user-id",
      deduplicated: false,
    }),
    runAgentLoop: async () => undefined,
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
  return {
    conversation,
    enqueuedMetadata: () => enqueuedMetadata,
    denyAllCount: () => denyAllCount,
    abortCount: () => abortCount,
  };
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
      conversationKey: "hidden-queue-key",
      content:
        "[User action on channel_setup surface: closed the slack setup wizard]",
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

const registeredRequestIds: string[] = [];
function registerConfirmation(): void {
  const requestId = `pending-confirmation-${registeredRequestIds.length}`;
  pendingInteractions.register(requestId, {
    conversationId: CONV_ID,
    kind: "confirmation",
  });
  registeredRequestIds.push(requestId);
}

afterEach(() => {
  for (const id of registeredRequestIds) {
    pendingInteractions.resolve(id, "cancelled");
  }
  registeredRequestIds.length = 0;
  deleteConversation(CONV_ID);
});

describe("hidden sends queued behind an in-flight turn", () => {
  test("carry hidden metadata and do NOT supersede pending interactions", async () => {
    const spies = makeBusyConversation();
    setConversation(CONV_ID, spies.conversation);
    registerConfirmation();

    const res = await callHandler(
      (args) => handleSendMessage(args, makeDeps(spies.conversation)),
      makeRequest({ hidden: true }),
      undefined,
      202,
    );

    expect(res.status).toBe(202);
    // Queued with the transcript-suppression flag intact...
    expect(spies.enqueuedMetadata()?.hidden).toBe(true);
    // ...without auto-denying the live approval prompt or aborting the turn:
    // a passive UI event is not the user choosing to move on.
    expect(spies.denyAllCount()).toBe(0);
    expect(spies.abortCount()).toBe(0);
  });

  test("visible sends in the same state keep the supersede behavior", async () => {
    const spies = makeBusyConversation();
    setConversation(CONV_ID, spies.conversation);
    registerConfirmation();

    const res = await callHandler(
      (args) => handleSendMessage(args, makeDeps(spies.conversation)),
      makeRequest({ content: "actually, do this instead" }),
      undefined,
      202,
    );

    expect(res.status).toBe(202);
    expect(spies.enqueuedMetadata()?.hidden).toBeUndefined();
    // The typed message supersedes: pending confirmations are auto-denied.
    expect(spies.denyAllCount()).toBe(1);
  });
});

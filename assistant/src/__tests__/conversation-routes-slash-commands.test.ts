/**
 * Tests for slash command interception in the POST /v1/messages handler.
 *
 * Validates that:
 * - Built-in slash commands (/context, /models, /commands) are intercepted and
 *   do NOT trigger the agent loop.
 * - Regular messages pass through to the agent loop unchanged.
 */
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import { setOverridesForTesting } from "./feature-flag-test-helpers.js";
import { setConfig } from "./helpers/set-config.js";

// Legacy-shaped fixtures (llm.default-centric resolution): pinned to the
// flag-off cascade. Override-or-default (flag-on) semantics are pinned by
// llm-resolver-override-or-default.test.ts and its companion suites.
beforeAll(() => {
  setOverridesForTesting({ "override-or-default-resolution": false });
});

mock.module("../config/env.js", () => ({ isHttpAuthDisabled: () => true }));

const formatCompactResultMock = mock(
  (result: { maxInputTokens: number }) =>
    `Context Compacted\n\nContext: 10,000 / ${result.maxInputTokens.toLocaleString(
      "en-US",
    )} tokens`,
);

// The /context and /compact branches resolve the conversation's override
// profile ("short-context", via the mocked getConversationOverrideProfile)
// against the real workspace config, so seed the profile plus the default
// model the assertions render.
setConfig("llm", {
  default: { model: "claude-opus-4-7" },
  profiles: {
    "short-context": {
      contextWindow: { maxInputTokens: 150000 },
    },
  },
});

const addMessageMock = mock(
  async (
    _conversationId: string,
    role: string,
    _content?: string,
    _metadata?: Record<string, unknown>,
  ) => ({
    id: role === "user" ? "persisted-user-id" : "persisted-assistant-id",
    deduplicated: false,
  }),
);

mock.module("../persistence/conversation-key-store.js", () => ({
  getOrCreateConversation: () => ({ conversationId: "conv-slash-test" }),
  getConversationByKey: () => null,
}));

mock.module("../persistence/attachments-store.js", () => ({
  getAttachmentsByIds: () => [],
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
  addMessage: (
    conversationId: string,
    role: string,
    content: string,
    options?: { metadata?: Record<string, unknown> },
  ) => addMessageMock(conversationId, role, content, options),
  extractImageSourcePaths: () => undefined,
  getConversation: () => null,
  getConversationOverrideProfile: () => "short-context",
  getMessages: () => [],
  provenanceFromTrustContext: (ctx: unknown) =>
    ctx
      ? { provenanceTrustClass: (ctx as Record<string, unknown>).trustClass }
      : { provenanceTrustClass: "unknown" },
  setConversationOriginChannelIfUnset: () => {},
  setConversationOriginInterfaceIfUnset: () => {},
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
    model: "claude-opus-4-6",
    provider: "anthropic",
    configuredProviders: ["anthropic", "ollama"],
  }),
  isModelSlashCommand: (content: string) => {
    return content.trim() === "/models";
  },
  formatCompactResult: formatCompactResultMock,
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

const ipcCallMock = mock(
  async (): Promise<Record<string, unknown> | undefined> => ({ ok: true }),
);
mock.module("../ipc/gateway-client.js", () => ({
  ipcCall: ipcCallMock,
}));

import type { AuthContext } from "../runtime/auth/types.js";
import { handleSendMessage } from "../runtime/routes/conversation-routes.js";
import { callHandler } from "./helpers/call-route-handler.js";

const _testAuthContext: AuthContext = {
  subject: "actor:self:test-guardian",
  principalType: "actor",
  assistantId: "self",
  actorPrincipalId: "test-guardian",
  scopeProfile: "actor_client_v1",
  scopes: new Set([
    "chat.read",
    "chat.write",
    "approval.read",
    "approval.write",
    "settings.read",
    "settings.write",
    "attachments.read",
    "attachments.write",
    "calls.read",
    "calls.write",
    "feature_flags.read",
    "feature_flags.write",
  ]),
  policyEpoch: 1,
};

function makeConversation() {
  const persistUserMessage = mock(
    async (_options: {
      content: string;
      attachments?: unknown[];
      requestId?: string;
      metadata?: Record<string, unknown>;
      clientMessageId?: string;
    }) => ({ id: "persisted-user-id", deduplicated: false }),
  );
  const runAgentLoop = mock(
    async (
      _content: string,
      _messageId: string,
      _onEvent: unknown,
      _options?: unknown,
    ) => undefined,
  );
  const setPreactivatedSkillIds = mock((_ids: string[] | undefined) => {});
  const forceCompact = mock(async () => ({
    messages: [],
    compacted: true,
    previousEstimatedInputTokens: 12000,
    estimatedInputTokens: 10000,
    maxInputTokens: 150000,
    thresholdTokens: 120000,
    compactedMessages: 2,
    compactedPersistedMessages: 2,
    summaryCalls: 1,
    summaryInputTokens: 500,
    summaryOutputTokens: 100,
    summaryModel: "claude-opus-4-7",
    summaryText: "Summary",
  }));
  const events: unknown[] = [];
  const messages: unknown[] = [];
  let processing = false;
  const conversation = {
    conversationId: "conv-slash-test",
    messages,
    abortController: null,
    currentRequestId: undefined,
    queue: { length: 0 },
    setTrustContext: () => {},
    updateClient: (_fn: unknown, _b: boolean) => {},
    emitConfirmationStateChanged: () => {},
    emitActivityState: () => {},
    setTurnChannelContext: () => {},
    setTurnInterfaceContext: () => {},
    getTurnChannelContext: () => null,
    getTurnInterfaceContext: () => null,
    ensureActorScopedHistory: async () => {},
    isProcessing: () => processing,
    setProcessing: (value: boolean) => {
      processing = value;
    },
    hasAnyPendingConfirmation: () => false,
    denyAllPendingConfirmations: () => {},
    enqueueMessage: () => ({ queued: true, requestId: "queued-id" }),
    persistUserMessage,
    runAgentLoop,
    forceCompact,
    setPreactivatedSkillIds,
    drainQueue: async () => {},
    warmPromptCache: () => {},
    getMessages: () => messages,
    assistantId: "self",
    trustContext: undefined,
    hasPendingConfirmation: () => false,
    setHostBrowserProxy: () => {},
    setHostCuProxy: () => {},
    setHostAppControlProxy: () => {},
    addPreactivatedSkillId: () => {},
    usageStats: {
      inputTokens: 1000,
      outputTokens: 500,
      estimatedCost: 0.05,
    },
  } as unknown as import("../daemon/conversation.js").Conversation;
  return {
    conversation,
    persistUserMessage,
    runAgentLoop,
    setPreactivatedSkillIds,
    events,
    messages,
    forceCompact,
  };
}

function makeRequest(content: string, extras: Record<string, unknown> = {}) {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-vellum-actor-principal-id": "test-user",
      "x-vellum-principal-type": "actor",
    },
    body: JSON.stringify({
      conversationKey: "slash-test-key",
      content,
      sourceChannel: "vellum",
      interface: "macos",
      ...extras,
    }),
  });
}

function makeDeps(
  conversation: import("../daemon/conversation.js").Conversation,
) {
  return {
    sendMessageDeps: {
      getOrCreateConversation: async () => conversation,
      assistantEventHub: { publish: async () => {} } as any,
      resolveAttachments: () => [],
    },
  };
}

describe("handleSendMessage slash command interception", () => {
  beforeEach(() => {
    formatCompactResultMock.mockClear();
    addMessageMock.mockClear();
    ipcCallMock.mockClear();
  });

  test("intercepts built-in slash commands (unknown kind) without calling agent loop", async () => {
    const { conversation, persistUserMessage, runAgentLoop } =
      makeConversation();
    const res = await callHandler(
      (args) => handleSendMessage(args, makeDeps(conversation)),
      makeRequest("/context"),
      undefined,
      202,
    );

    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      accepted: boolean;
      messageId?: string;
    };
    expect(body.accepted).toBe(true);
    expect(body.messageId).toBe("persisted-user-id");

    // User + assistant messages persisted, but agent loop NOT called
    expect(addMessageMock).toHaveBeenCalledTimes(2);
    const roles = addMessageMock.mock.calls.map((c) => c[1]);
    expect(roles).toEqual(["user", "assistant"]);
    expect(persistUserMessage).not.toHaveBeenCalled();
    expect(runAgentLoop).not.toHaveBeenCalled();
  });

  test("handles /compact without calling agent loop and formats the compaction max", async () => {
    const { conversation, persistUserMessage, runAgentLoop, forceCompact } =
      makeConversation();
    const res = await callHandler(
      (args) => handleSendMessage(args, makeDeps(conversation)),
      makeRequest("/compact"),
      undefined,
      202,
    );

    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      accepted: boolean;
      messageId?: string;
    };
    expect(body.accepted).toBe(true);
    expect(body.messageId).toBe("persisted-user-id");

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(forceCompact).toHaveBeenCalledTimes(1);
    expect(formatCompactResultMock).toHaveBeenCalledWith(
      expect.objectContaining({ maxInputTokens: 150000 }),
    );
    expect(persistUserMessage).not.toHaveBeenCalled();
    expect(runAgentLoop).not.toHaveBeenCalled();
  });

  test("clears processing and drains the queue when /compact's initial persist fails", async () => {
    const { conversation } = makeConversation();
    const drainQueue = mock(async () => {});
    (
      conversation as unknown as {
        drainQueue: () => Promise<void>;
      }
    ).drainQueue = drainQueue;

    // Force the user-message persist (the first addMessage in the /compact
    // branch, on the synchronous pre-202 path) to throw.
    addMessageMock.mockImplementationOnce(async () => {
      throw new Error("disk full");
    });

    // The failure surfaces to the caller rather than silently 202-ing.
    let caught: Error | undefined;
    try {
      await callHandler(
        (args) => handleSendMessage(args, makeDeps(conversation)),
        makeRequest("/compact"),
        undefined,
        202,
      );
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).toBe("disk full");

    // Regression: without the guard `processing` stays stuck true, leaving
    // every later send queued forever; the queue must also be drained.
    expect(conversation.isProcessing()).toBe(false);
    expect(drainQueue).toHaveBeenCalledTimes(1);
  });

  test("passes regular messages through to agent loop unchanged", async () => {
    const {
      conversation,
      persistUserMessage,
      runAgentLoop,
      setPreactivatedSkillIds,
    } = makeConversation();
    const res = await callHandler(
      (args) => handleSendMessage(args, makeDeps(conversation)),
      makeRequest("hello there"),
      undefined,
      202,
    );

    expect(res.status).toBe(202);

    // No skill preactivation
    expect(setPreactivatedSkillIds).not.toHaveBeenCalled();

    // Agent loop called with original content
    expect(persistUserMessage).toHaveBeenCalledTimes(1);
    expect(runAgentLoop).toHaveBeenCalledTimes(1);
    const loopContent = runAgentLoop.mock.calls[0][0];
    expect(loopContent).toBe("hello there");
  });

  test("passes SlashContext with resolved profile context budget", async () => {
    const { conversation } = makeConversation();
    await callHandler(
      (args) => handleSendMessage(args, makeDeps(conversation)),
      makeRequest("/context"),
      undefined,
      202,
    );

    const assistantPersist = addMessageMock.mock.calls.find(
      (call) => call[1] === "assistant",
    );
    expect(assistantPersist).toBeDefined();
    expect(String(assistantPersist?.[2])).toContain("1,000 / 150,000 tokens");
    expect(String(assistantPersist?.[2])).toContain(
      "claude-opus-4-7 (anthropic)",
    );
  });

  test("applies riskThreshold override when provided", async () => {
    const { conversation } = makeConversation();
    const res = await callHandler(
      (args) => handleSendMessage(args, makeDeps(conversation)),
      makeRequest("hello there", { riskThreshold: "none" }),
      undefined,
      202,
    );

    expect(res.status).toBe(202);
    expect(ipcCallMock).toHaveBeenCalledWith("set_conversation_threshold", {
      conversationId: "conv-slash-test",
      threshold: "none",
    });
  });

  test("returns 500 when riskThreshold IPC fails", async () => {
    ipcCallMock.mockImplementationOnce(async () => undefined);

    const { conversation } = makeConversation();
    const res = await callHandler(
      (args) => handleSendMessage(args, makeDeps(conversation)),
      makeRequest("hello there", { riskThreshold: "none" }),
      undefined,
      202,
    );

    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).toContain("risk threshold");
  });

  test("rejects invalid riskThreshold values", async () => {
    const { conversation } = makeConversation();
    const res = await callHandler(
      (args) => handleSendMessage(args, makeDeps(conversation)),
      makeRequest("hello there", { riskThreshold: "critical" }),
      undefined,
      202,
    );

    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("riskThreshold");
    expect(ipcCallMock).not.toHaveBeenCalled();
  });
});

// The first-message wake-up greeting ("Wake up, my friend!") is served as a
// canned response that skips the agent loop, just like a slash command. Its
// user row must still carry the client-generated idempotency nonce so the web
// client can reconcile its optimistic row against the persisted one — otherwise
// the greeting renders twice (see the "two wakeup messages" staging report).
describe("handleSendMessage canned wake-up greeting", () => {
  // `isWakeUpGreeting` resolves BOOTSTRAP.md via getWorkspacePromptPath, which
  // is rooted at VELLUM_WORKSPACE_DIR (the per-test temp workspace).
  const bootstrapPath = join(process.env.VELLUM_WORKSPACE_DIR!, "BOOTSTRAP.md");

  beforeEach(() => {
    addMessageMock.mockClear();
    // `isWakeUpGreeting` only treats the message as the wake-up greeting when
    // BOOTSTRAP.md exists at the workspace prompt path (i.e. a first run).
    writeFileSync(bootstrapPath, "# Bootstrap\n\nFirst run.");
  });

  afterEach(() => {
    if (existsSync(bootstrapPath)) {
      rmSync(bootstrapPath, { force: true });
    }
  });

  test("persists the clientMessageId on the user row", async () => {
    const { conversation, runAgentLoop } = makeConversation();
    const res = await callHandler(
      (args) => handleSendMessage(args, makeDeps(conversation)),
      makeRequest("Wake up, my friend!", {
        clientMessageId: "nonce-wake-123",
      }),
      undefined,
      202,
    );

    expect(res.status).toBe(202);
    // Canned greeting path: user + assistant rows persisted, agent loop skipped.
    expect(runAgentLoop).not.toHaveBeenCalled();
    const userCall = addMessageMock.mock.calls.find((c) => c[1] === "user");
    expect(userCall).toBeDefined();
    const options = userCall?.[3] as { clientMessageId?: string } | undefined;
    expect(options?.clientMessageId).toBe("nonce-wake-123");
  });
});

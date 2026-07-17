/**
 * Tests for HTTP POST /v1/messages behavior after the legacy handleUserMessage
 * legacy entry point was retired.
 *
 * Recording intent interception has been deliberately retired — the HTTP path
 * has dedicated /v1/recording/* endpoints and the model handles
 * recording-related messages through the agent loop.
 *
 * Approval reply interception has parity and is covered by
 * conversation-routes-guardian-reply.test.ts and send-endpoint-busy.test.ts.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

// ────────────────────────────────────────────────────────────────────────────
// Module mocks — must be set up before any imports that pull in the mocked
// modules. These are shared across all describe blocks in this file.
// ────────────────────────────────────────────────────────────────────────────

mock.module("../config/env.js", () => ({ isHttpAuthDisabled: () => true }));

const routeGuardianReplyMock = mock(async () => ({
  consumed: false,
  decisionApplied: false,
  type: "not_consumed" as const,
})) as any;

const addMessageMock = mock(
  async (
    _conversationId: string,
    role: string,
    _content?: string,
    _metadata?: Record<string, unknown>,
  ) => ({
    id: role === "user" ? "persisted-user-id" : "persisted-assistant-id",
  }),
);

mock.module("../persistence/conversation-key-store.js", () => ({
  getOrCreateConversation: () => ({ conversationId: "conv-parity-test" }),
  getConversationByKey: () => null,
}));

mock.module("../persistence/attachments-store.js", () => ({
  getAttachmentsByIds: () => [],
}));

mock.module("../runtime/guardian-reply-router.js", () => ({
  routeGuardianReply: routeGuardianReplyMock,
}));

// Stub for the shared reset-drift helper. handleSendMessage only consumes its
// result (a guardian TrustContext or null) on a first-pass-unknown actor; the
// gate itself is covered in runtime/__tests__/guardian-vellum-migration.test.ts.
const reResolveCalls: string[] = [];
let mockReResolve: { trustClass: string; sourceChannel: string } | null = null;
mock.module("../runtime/guardian-vellum-migration.js", () => ({
  reResolveTrustOnResetDrift: async (
    incomingPrincipalId: string,
    _sourceChannel: string,
  ) => {
    reResolveCalls.push(incomingPrincipalId);
    return mockReResolve;
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
  addMessage: (
    conversationId: string,
    role: string,
    content: string,
    options?: { metadata?: Record<string, unknown> },
  ) => addMessageMock(conversationId, role, content, options),
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
  recordConversationPersistedSeq: () => {},
}));

mock.module("../runtime/local-actor-identity.js", () => ({
  findLocalGuardianPrincipalId: async () =>
    mockGuardians?.find(
      (g) => g.channelType === "vellum" && g.status === "active",
    )?.principalId as string | undefined,
}));

// Capture the sourceActorPrincipalId that handleSendMessage threads into
// shouldAttachHostProxyForCapability / preactivateHostProxySkills, so tests
// can assert the dev-bypass translation landed before the CU proxy gate.
// The macOS "native_support" path short-circuits before reading the
// principal, so only web/ios turns exercise the same-actor branch.
const hostProxyAttachCalls: Array<{
  capability: string;
  sourceInterface: unknown;
  sourceActorPrincipalId: string | undefined;
}> = [];
const preactivateCalls: Array<{
  sourceInterface: unknown;
  sourceActorPrincipalId: string | undefined;
}> = [];
mock.module("../daemon/host-proxy-preactivation.js", () => ({
  shouldAttachHostProxyForCapability: (
    capability: string,
    sourceInterface: unknown,
    sourceActorPrincipalId: string | undefined,
  ) => {
    hostProxyAttachCalls.push({
      capability,
      sourceInterface,
      sourceActorPrincipalId,
    });
    // Return false so the route skips proxy instantiation; we only care
    // that the translated principal reached the gate.
    return false;
  },
  preactivateHostProxySkills: (
    _conversation: unknown,
    sourceInterface: unknown,
    sourceActorPrincipalId: string | undefined,
  ) => {
    preactivateCalls.push({ sourceInterface, sourceActorPrincipalId });
  },
}));

let mockGuardians: Array<Record<string, unknown>> | null = [
  {
    channelType: "vellum",
    contactId: "guardian-contact",
    principalId: "test-user",
    address: "test-user",
    status: "active",
  },
];

mock.module("../contacts/guardian-delivery-reader.js", () => ({
  getGuardianDelivery: async () => mockGuardians,
  guardianForChannel: (
    list: Array<Record<string, unknown>>,
    channelType: string,
  ) => list.find((g) => g.channelType === channelType && g.status === "active"),
}));

// handleSendMessage wraps the first-pass resolve with withSourceChannel.
mock.module("../runtime/trust-context-resolver.js", () => ({
  withSourceChannel: (sourceChannel: unknown, ctx: unknown) => ({
    ...(ctx as Record<string, unknown>),
    sourceChannel,
  }),
}));

import type { AuthContext } from "../runtime/auth/types.js";
import { handleSendMessage } from "../runtime/routes/conversation-routes.js";
import { callHandler } from "./helpers/call-route-handler.js";

const _testAuthContext: AuthContext = {
  subject: "actor:self:test-actor",
  principalType: "actor",
  assistantId: "self",
  actorPrincipalId: "test-actor",
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

// ── Helper: create a minimal mock conversation ─────────────────────────────
function makeConversation(overrides: Record<string, unknown> = {}) {
  return {
    setTrustContext: () => {},
    updateClient: () => {},
    setHostBrowserProxy: () => {},
    setHostCuProxy: () => {},
    setHostAppControlProxy: () => {},
    addPreactivatedSkillId: () => {},
    emitConfirmationStateChanged: () => {},
    emitActivityState: () => {},
    setTurnChannelContext: () => {},
    setTurnInterfaceContext: () => {},
    ensureActorScopedHistory: async () => {},
    usageStats: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
    isProcessing: () => false,
    hasAnyPendingConfirmation: () => false,
    denyAllPendingConfirmations: () => {},
    enqueueMessage: () => ({ queued: true, requestId: "queued-id" }),
    persistUserMessage: mock(async () => ({
      id: "persisted-user-id",
      deduplicated: false,
    })),
    runAgentLoop: mock(async () => undefined),
    getMessages: () => [] as unknown[],
    assistantId: "self",
    trustContext: undefined,
    hasPendingConfirmation: () => false,
    ...overrides,
  } as unknown as import("../daemon/conversation.js").Conversation;
}

// ── Helper: create an HTTP request to POST /v1/messages ────────────────────
function makeRequest(
  content: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-vellum-actor-principal-id": "test-user",
      "x-vellum-principal-type": "actor",
      ...headers,
    },
    body: JSON.stringify({
      conversationKey: "parity-test-key",
      content,
      sourceChannel: "vellum",
      interface: "macos",
      ...extra,
    }),
  });
}

// ── Helper: send a message through handleSendMessage ───────────────────────
async function sendMessage(
  content: string,
  conversationObj: import("../daemon/conversation.js").Conversation,
  extra: Record<string, unknown> = {},
  options: {
    onGetOrCreateConversation?: (
      conversationId: string,
      opts?: Record<string, unknown>,
    ) => void;
    headers?: Record<string, string>;
  } = {},
) {
  return callHandler(
    (args) =>
      handleSendMessage(args, {
        sendMessageDeps: {
          getOrCreateConversation: async (conversationId, opts) => {
            options.onGetOrCreateConversation?.(
              conversationId,
              opts as Record<string, unknown> | undefined,
            );
            return conversationObj;
          },
          assistantEventHub: { publish: async () => {} } as any,
          resolveAttachments: () => [],
        },
      }),
    makeRequest(content, extra, options.headers ?? {}),
    undefined,
    202,
  );
}

// ============================================================================
// RECORDING INTENT — deliberately NOT intercepted on HTTP path
// ============================================================================
describe("HTTP POST /v1/messages does not intercept recording intents (by design)", () => {
  beforeEach(() => {
    routeGuardianReplyMock.mockClear();
    addMessageMock.mockClear();
  });

  test("recording commands pass through to the agent loop as regular messages", async () => {
    // The HTTP path deliberately does not intercept recording commands.
    // Dedicated /v1/recording/* endpoints handle recording lifecycle.
    // Text-based recording intent interception was retired with the
    // legacy handleUserMessage entry point.
    const persistUserMessage = mock(async () => ({
      id: "persisted-msg-id",
      deduplicated: false,
    }));
    const runAgentLoop = mock(async () => undefined);
    const conversation = makeConversation({ persistUserMessage, runAgentLoop });

    const res = await sendMessage("start recording", conversation);

    expect(res.status).toBe(202);
    expect(persistUserMessage).toHaveBeenCalledTimes(1);
    expect(runAgentLoop).toHaveBeenCalledTimes(1);
  });

  test("structured commandIntent recording actions are ignored by HTTP path", async () => {
    // Even when the request includes a structured commandIntent for recording,
    // the HTTP path does not parse or act on it — handleSendMessage only reads
    // content, conversationKey, attachmentIds, sourceChannel, and interface.
    // This ensures a future regression that starts parsing commandIntent would
    // be caught.
    const persistUserMessage = mock(async () => ({
      id: "persisted-msg-id",
      deduplicated: false,
    }));
    const runAgentLoop = mock(async () => undefined);
    const conversation = makeConversation({ persistUserMessage, runAgentLoop });

    const res = await sendMessage("start screen recording", conversation, {
      commandIntent: { type: "start_recording", payload: "screen" },
    });

    expect(res.status).toBe(202);
    expect(persistUserMessage).toHaveBeenCalledTimes(1);
    expect(runAgentLoop).toHaveBeenCalledTimes(1);
  });

  test("stop recording commands pass through to the agent loop", async () => {
    const persistUserMessage = mock(async () => ({
      id: "persisted-msg-id",
      deduplicated: false,
    }));
    const runAgentLoop = mock(async () => undefined);
    const conversation = makeConversation({ persistUserMessage, runAgentLoop });

    const res = await sendMessage("stop recording", conversation);

    expect(res.status).toBe(202);
    expect(persistUserMessage).toHaveBeenCalledTimes(1);
    expect(runAgentLoop).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// CLIENT TIMEZONE — optional HTTP metadata
// ============================================================================
describe("HTTP POST /v1/messages clientTimezone transport metadata", () => {
  beforeEach(() => {
    routeGuardianReplyMock.mockClear();
    addMessageMock.mockClear();
  });

  test("passes canonical clientTimezone through host-proxy transport", async () => {
    const persistUserMessage = mock(async () => ({
      id: "persisted-msg-id",
      deduplicated: false,
    }));
    const runAgentLoop = mock(async () => undefined);
    const conversation = makeConversation({ persistUserMessage, runAgentLoop });
    let capturedOptions: Record<string, unknown> | undefined;

    const res = await sendMessage(
      "hello",
      conversation,
      { clientTimezone: "america/new_york" },
      {
        onGetOrCreateConversation: (_conversationId, opts) => {
          capturedOptions = opts;
        },
      },
    );

    expect(res.status).toBe(202);
    expect(capturedOptions).toEqual({
      transport: {
        channelId: "vellum",
        interfaceId: "macos",
        clientTimezone: "America/New_York",
      },
    });
  });

  test("passes canonical clientTimezone through non-host-proxy transport", async () => {
    const persistUserMessage = mock(async () => ({
      id: "persisted-msg-id",
      deduplicated: false,
    }));
    const runAgentLoop = mock(async () => undefined);
    const conversation = makeConversation({ persistUserMessage, runAgentLoop });
    let capturedOptions: Record<string, unknown> | undefined;

    const res = await sendMessage(
      "hello",
      conversation,
      { interface: "ios", clientTimezone: "europe/london" },
      {
        onGetOrCreateConversation: (_conversationId, opts) => {
          capturedOptions = opts;
        },
      },
    );

    expect(res.status).toBe(202);
    expect(capturedOptions).toEqual({
      transport: {
        channelId: "vellum",
        interfaceId: "ios",
        clientTimezone: "Europe/London",
      },
    });
  });

  test("drops invalid clientTimezone without rejecting the message", async () => {
    const persistUserMessage = mock(async () => ({
      id: "persisted-msg-id",
      deduplicated: false,
    }));
    const runAgentLoop = mock(async () => undefined);
    const conversation = makeConversation({ persistUserMessage, runAgentLoop });
    let capturedOptions: Record<string, unknown> | undefined;

    const res = await sendMessage(
      "hello",
      conversation,
      { clientTimezone: "not-a-timezone" },
      {
        onGetOrCreateConversation: (_conversationId, opts) => {
          capturedOptions = opts;
        },
      },
    );

    expect(res.status).toBe(202);
    expect(capturedOptions).toEqual({
      transport: {
        channelId: "vellum",
        interfaceId: "macos",
      },
    });
    expect(persistUserMessage).toHaveBeenCalledTimes(1);
    expect(runAgentLoop).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// CLIENT METADATA — sanitized x-vellum-* headers persisted under
// metadata.client for turn analytics
// ============================================================================
describe("HTTP POST /v1/messages client metadata headers", () => {
  beforeEach(() => {
    routeGuardianReplyMock.mockClear();
    addMessageMock.mockClear();
  });

  const clientMetadataHeaders = {
    "x-vellum-browser-family": "safari",
    "x-vellum-browser-version": "17",
    "x-vellum-client-os": "ios",
    "x-vellum-interface-version": "1.2.3",
  };

  test("persists client metadata on immediate user messages", async () => {
    const persistUserMessage = mock(
      async (_options: { metadata?: Record<string, unknown> }) => ({
        id: "persisted-msg-id",
        deduplicated: false,
      }),
    );
    const runAgentLoop = mock(async () => undefined);
    const conversation = makeConversation({ persistUserMessage, runAgentLoop });

    const res = await sendMessage(
      "hello",
      conversation,
      {},
      {
        headers: clientMetadataHeaders,
      },
    );

    expect(res.status).toBe(202);
    expect(persistUserMessage).toHaveBeenCalledTimes(1);
    const persistCall = persistUserMessage.mock.calls[0];
    expect(persistCall).toBeDefined();
    const [persistOptions] = persistCall as unknown as [
      { metadata?: Record<string, unknown> },
    ];
    expect(persistOptions.metadata).toEqual({
      client: {
        browser_family: "safari",
        browser_version: "17",
        os: "ios",
        interface_version: "1.2.3",
      },
    });
  });

  test("persists client metadata on queued user messages", async () => {
    const enqueueMessage = mock(
      (_options: { metadata?: Record<string, unknown> }) => ({
        queued: true,
        requestId: "queued-id",
      }),
    );
    const conversation = makeConversation({
      isProcessing: () => true,
      enqueueMessage,
    });

    const res = await sendMessage(
      "hello",
      conversation,
      {},
      {
        headers: clientMetadataHeaders,
      },
    );

    expect(res.status).toBe(202);
    expect(enqueueMessage).toHaveBeenCalledTimes(1);
    const enqueueCall = enqueueMessage.mock.calls[0];
    expect(enqueueCall).toBeDefined();
    const [enqueueOptions] = enqueueCall as unknown as [
      { metadata?: Record<string, unknown> },
    ];
    expect(enqueueOptions.metadata).toMatchObject({
      client: {
        browser_family: "safari",
        browser_version: "17",
        os: "ios",
        interface_version: "1.2.3",
      },
    });
  });

  test("malformed header values are dropped, valid ones kept", async () => {
    const persistUserMessage = mock(
      async (_options: { metadata?: Record<string, unknown> }) => ({
        id: "persisted-msg-id",
        deduplicated: false,
      }),
    );
    const runAgentLoop = mock(async () => undefined);
    const conversation = makeConversation({ persistUserMessage, runAgentLoop });

    const res = await sendMessage(
      "hello",
      conversation,
      {},
      {
        headers: {
          // Uppercase + space + disallowed chars → normalized or dropped.
          "x-vellum-browser-family": "  SAFARI  ",
          "x-vellum-browser-version": "not allowed!",
          "x-vellum-client-os": "a".repeat(65),
        },
      },
    );

    expect(res.status).toBe(202);
    const [persistOptions] = persistUserMessage.mock.calls[0] as unknown as [
      { metadata?: Record<string, unknown> },
    ];
    expect(persistOptions.metadata).toEqual({
      client: { browser_family: "safari" },
    });
  });

  test("no client metadata headers → metadata unchanged", async () => {
    const persistUserMessage = mock(
      async (_options: { metadata?: Record<string, unknown> }) => ({
        id: "persisted-msg-id",
        deduplicated: false,
      }),
    );
    const runAgentLoop = mock(async () => undefined);
    const conversation = makeConversation({ persistUserMessage, runAgentLoop });

    const res = await sendMessage("hello", conversation);

    expect(res.status).toBe(202);
    const [persistOptions] = persistUserMessage.mock.calls[0] as unknown as [
      { metadata?: Record<string, unknown> },
    ];
    expect(persistOptions.metadata).toBeUndefined();
  });
});

// ============================================================================
// TRUST CONTEXT — derived from the gateway guardian binding
// ============================================================================
describe("HTTP POST /v1/messages trust context from the gateway binding", () => {
  beforeEach(() => {
    mockGuardians = [
      {
        channelType: "vellum",
        contactId: "guardian-contact",
        principalId: "test-user",
        address: "test-user",
        status: "active",
      },
    ];
    reResolveCalls.length = 0;
    mockReResolve = null;
  });

  function requestAs(principalId: string, sourceChannel = "vellum") {
    return new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-vellum-actor-principal-id": principalId,
        "x-vellum-principal-type": "actor",
      },
      body: JSON.stringify({
        conversationKey: "trust-test-key",
        content: "hi",
        sourceChannel,
        interface: "macos",
      }),
    });
  }

  async function trustContextFor(
    principalId: string,
    sourceChannel = "vellum",
  ): Promise<Record<string, unknown>> {
    let captured: Record<string, unknown> | undefined;
    const conversation = makeConversation({
      setTrustContext: (ctx: Record<string, unknown>) => {
        captured = ctx;
      },
    });
    const res = await callHandler(
      (args) =>
        handleSendMessage(args, {
          sendMessageDeps: {
            getOrCreateConversation: async () => conversation,
            assistantEventHub: { publish: async () => {} } as any,
            resolveAttachments: () => [],
          },
        }),
      requestAs(principalId, sourceChannel),
      undefined,
      202,
    );
    expect(res.status).toBe(202);
    return captured ?? {};
  }

  async function trustClassFor(principalId: string): Promise<string> {
    return (await trustContextFor(principalId)).trustClass as string;
  }

  test("guardian principal resolves to guardian context, helper not called", async () => {
    expect(await trustClassFor("test-user")).toBe("guardian");
    expect(reResolveCalls).toEqual([]);
  });

  test("non-guardian principal: helper consulted, null result stays unknown", async () => {
    mockReResolve = null;
    expect(await trustClassFor("vellum-principal-stranger")).toBe("unknown");
    expect(reResolveCalls).toEqual(["vellum-principal-stranger"]);
  });

  test("reset drift: helper returns guardian → route adopts it", async () => {
    mockGuardians = [
      {
        channelType: "vellum",
        contactId: "guardian-contact",
        principalId: "vellum-principal-stale",
        address: "vellum-principal-stale",
        status: "active",
      },
    ];
    mockReResolve = { trustClass: "guardian", sourceChannel: "vellum" };

    expect(await trustClassFor("vellum-principal-healed")).toBe("guardian");
    expect(reResolveCalls).toEqual(["vellum-principal-healed"]);
  });

  test("helper returns an unknown-class ctx → trust stays unknown (not adopted)", async () => {
    mockGuardians = [
      {
        channelType: "vellum",
        contactId: "guardian-contact",
        principalId: "vellum-principal-stale",
        address: "vellum-principal-stale",
        status: "active",
      },
    ];
    mockReResolve = { trustClass: "unknown", sourceChannel: "vellum" };

    expect(await trustClassFor("vellum-principal-healed")).toBe("unknown");
  });

  test("dev-bypass maps the gateway guardian principal to guardian", async () => {
    expect(await trustClassFor("dev-bypass")).toBe("guardian");
  });

  test("dev-bypass fails closed to unknown on an empty gateway", async () => {
    // No active gateway binding: dev-bypass cannot translate to a real guardian,
    // and the helper (null) leaves trust unknown — parity with /v1/surface-actions.
    mockGuardians = [];
    mockReResolve = null;
    expect(await trustClassFor("dev-bypass")).toBe("unknown");
  });

  test("preserves the request body channel on the guardian-match happy path", async () => {
    const ctx = await trustContextFor("test-user", "telegram");
    expect(ctx.trustClass).toBe("guardian");
    expect(ctx.sourceChannel).toBe("telegram");
  });

  // A web turn's "dev-bypass" principal must translate to the real guardian
  // principal before the CU/app-control same-actor proxy-attachment gate,
  // so it matches the macOS client's SSE-registered principal.
  test("dev-bypass is translated to the guardian principal before the CU proxy attach gate (web turn)", async () => {
    hostProxyAttachCalls.length = 0;
    preactivateCalls.length = 0;
    const conversation = makeConversation();
    const res = await callHandler(
      (args) =>
        handleSendMessage(args, {
          sendMessageDeps: {
            getOrCreateConversation: async () => conversation,
            assistantEventHub: { publish: async () => {} } as any,
            resolveAttachments: () => [],
          },
        }),
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-vellum-actor-principal-id": "dev-bypass",
          "x-vellum-principal-type": "actor",
        },
        body: JSON.stringify({
          conversationKey: "cu-attach-key",
          content: "hi",
          sourceChannel: "vellum",
          interface: "web",
        }),
      }),
      undefined,
      202,
    );
    expect(res.status).toBe(202);

    // The CU attach gate receives the translated guardian principal, not
    // the raw "dev-bypass" string.
    const cuCall = hostProxyAttachCalls.find((c) => c.capability === "host_cu");
    expect(cuCall).toBeDefined();
    expect(cuCall?.sourceActorPrincipalId).toBe("test-user");
    expect(cuCall?.sourceActorPrincipalId).not.toBe("dev-bypass");

    // Preactivation receives the same translated principal.
    const preactivateCall = preactivateCalls[0];
    expect(preactivateCall?.sourceActorPrincipalId).toBe("test-user");
  });

  test("real (non-dev-bypass) principal passes through the CU proxy attach gate unchanged", async () => {
    hostProxyAttachCalls.length = 0;
    const conversation = makeConversation();
    await callHandler(
      (args) =>
        handleSendMessage(args, {
          sendMessageDeps: {
            getOrCreateConversation: async () => conversation,
            assistantEventHub: { publish: async () => {} } as any,
            resolveAttachments: () => [],
          },
        }),
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-vellum-actor-principal-id": "real-jwt-principal",
          "x-vellum-principal-type": "actor",
        },
        body: JSON.stringify({
          conversationKey: "cu-attach-real-key",
          content: "hi",
          sourceChannel: "vellum",
          interface: "web",
        }),
      }),
      undefined,
      202,
    );

    const cuCall = hostProxyAttachCalls.find((c) => c.capability === "host_cu");
    expect(cuCall?.sourceActorPrincipalId).toBe("real-jwt-principal");
  });
});

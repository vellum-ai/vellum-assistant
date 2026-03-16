/**
 * Tests for confirmation response handling (handleConfirmationResponse).
 *
 * The legacy handleUserMessage tests that previously lived here were removed
 * when conversation-user-message.ts was deleted. The approval-reply behavior they
 * tested now lives on the HTTP path and is covered by
 * conversation-routes-guardian-reply.test.ts, send-endpoint-busy.test.ts,
 * and http-user-message-parity.test.ts.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../config/env.js", () => ({ isHttpAuthDisabled: () => true }));

import type { HandlerContext } from "../daemon/handlers/shared.js";
import type { ConfirmationResponse } from "../daemon/message-protocol.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import { DebouncerMap } from "../util/debounce.js";

const resolveCanonicalGuardianRequestMock = mock(
  () => null as { id: string } | null,
);
const resolveMock = mock(() => undefined as unknown);

// Bun's module mocks are global within the worker, so keep this mock
// transparent when this file is not actively exercising it.
const realCanonicalGuardianStore =
  await import("../memory/canonical-guardian-store.js");
(
  globalThis as Record<string, unknown>
).__approvalConsumptionUseMockCanonicalStore = false;

mock.module("../memory/canonical-guardian-store.js", () => ({
  createCanonicalGuardianRequest: (
    ...args: Parameters<
      typeof realCanonicalGuardianStore.createCanonicalGuardianRequest
    >
  ) =>
    (globalThis as Record<string, unknown>)
      .__approvalConsumptionUseMockCanonicalStore
      ? resolveCanonicalGuardianRequestMock()
      : realCanonicalGuardianStore.createCanonicalGuardianRequest(...args),
  generateCanonicalRequestCode: (
    ...args: Parameters<
      typeof realCanonicalGuardianStore.generateCanonicalRequestCode
    >
  ) =>
    (globalThis as Record<string, unknown>)
      .__approvalConsumptionUseMockCanonicalStore
      ? "ABC123"
      : realCanonicalGuardianStore.generateCanonicalRequestCode(...args),
  listPendingCanonicalGuardianRequestsByDestinationConversation: (
    ...args: Parameters<
      typeof realCanonicalGuardianStore.listPendingCanonicalGuardianRequestsByDestinationConversation
    >
  ) =>
    (globalThis as Record<string, unknown>)
      .__approvalConsumptionUseMockCanonicalStore
      ? []
      : realCanonicalGuardianStore.listPendingCanonicalGuardianRequestsByDestinationConversation(
          ...args,
        ),
  listCanonicalGuardianRequests: (
    ...args: Parameters<
      typeof realCanonicalGuardianStore.listCanonicalGuardianRequests
    >
  ) =>
    (globalThis as Record<string, unknown>)
      .__approvalConsumptionUseMockCanonicalStore
      ? []
      : realCanonicalGuardianStore.listCanonicalGuardianRequests(...args),
  resolveCanonicalGuardianRequest: (
    ...args: Parameters<
      typeof realCanonicalGuardianStore.resolveCanonicalGuardianRequest
    >
  ) =>
    (globalThis as Record<string, unknown>)
      .__approvalConsumptionUseMockCanonicalStore
      ? (
          resolveCanonicalGuardianRequestMock as unknown as (
            ...mockArgs: Parameters<
              typeof realCanonicalGuardianStore.resolveCanonicalGuardianRequest
            >
          ) => ReturnType<
            typeof realCanonicalGuardianStore.resolveCanonicalGuardianRequest
          >
        )(...args)
      : realCanonicalGuardianStore.resolveCanonicalGuardianRequest(...args),
}));

mock.module("../runtime/pending-interactions.js", () => ({
  register: mock(() => {}),
  getByConversation: mock(() => []),
  resolve: resolveMock,
}));

mock.module("../memory/conversation-crud.js", () => ({
  addMessage: mock(async () => ({ id: "persisted-message-id" })),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    daemon: { standaloneRecording: false },
    secretDetection: { customPatterns: [], entropyThreshold: 3.5 },
  }),
  loadConfig: () => ({}),
  loadRawConfig: () => ({}),
  saveConfig: () => {},
  saveRawConfig: () => {},
  invalidateConfigCache: () => {},
  applyNestedDefaults: (c: unknown) => c,
  getNestedValue: () => undefined,
  setNestedValue: () => {},
  API_KEY_PROVIDERS: [],
}));

mock.module("../runtime/local-actor-identity.js", () => ({
  resolveLocalTrustContext: () => ({
    trustClass: "guardian",
    sourceChannel: "vellum",
    guardianPrincipalId: "local-principal",
  }),
  resolveLocalAuthContext: () => ({
    scope: "local_v1",
    actorPrincipalId: "local-principal",
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realLogger = require("../util/logger.js");
mock.module("../util/logger.js", () => ({
  ...realLogger,
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    }),
  }),
}));

import { handleConfirmationResponse } from "../daemon/handlers/conversations.js";

interface TestConversation {
  messages: Array<{ role: string; content: unknown[] }>;
  setChannelCapabilities: (caps: unknown) => void;
  isProcessing: () => boolean;
  hasPendingConfirmation: (requestId: string) => boolean;
  hasAnyPendingConfirmation: () => boolean;
  getQueueDepth: () => number;
  denyAllPendingConfirmations: () => void;
  enqueueMessage: (...args: unknown[]) => {
    queued: boolean;
    requestId: string;
  };
  traceEmitter: { emit: (...args: unknown[]) => void };
  setTurnChannelContext: (ctx: unknown) => void;
  setTurnInterfaceContext: (ctx: unknown) => void;
  setAssistantId: (assistantId: string) => void;
  setTrustContext: (ctx: unknown) => void;
  setAuthContext: (ctx: unknown) => void;
  setCommandIntent: (intent: unknown) => void;
  updateClient: (
    sendToClient: (msg: ServerMessage) => void,
    hasNoClient?: boolean,
  ) => void;
  emitActivityState: (...args: unknown[]) => void;
  emitConfirmationStateChanged: (...args: unknown[]) => void;
  processMessage: (...args: unknown[]) => Promise<string>;
}

function createContext(conversationObj: TestConversation): {
  ctx: HandlerContext;
  sent: ServerMessage[];
} {
  const sent: ServerMessage[] = [];
  const ctx: HandlerContext = {
    conversations: new Map(),
    sharedRequestTimestamps: [],
    debounceTimers: new DebouncerMap({ defaultDelayMs: 100 }),
    suppressConfigReload: false,
    setSuppressConfigReload: () => {},
    updateConfigFingerprint: () => {},
    send: (msg) => {
      sent.push(msg);
    },
    broadcast: () => {},
    clearAllConversations: () => 0,
    getOrCreateConversation: async () => conversationObj as any,
    touchConversation: () => {},
  };
  return { ctx, sent };
}

function makeConversation(
  overrides: Partial<TestConversation> = {},
): TestConversation {
  return {
    messages: [],
    setChannelCapabilities: () => {},
    isProcessing: () => false,
    hasPendingConfirmation: () => true,
    hasAnyPendingConfirmation: () => true,
    getQueueDepth: () => 0,
    denyAllPendingConfirmations: mock(() => {}),
    enqueueMessage: mock(() => ({ queued: true, requestId: "queued-id" })),
    traceEmitter: { emit: () => {} },
    setTurnChannelContext: () => {},
    setTurnInterfaceContext: () => {},
    setAssistantId: () => {},
    setTrustContext: () => {},
    setAuthContext: () => {},
    setCommandIntent: () => {},
    updateClient: () => {},
    emitActivityState: () => {},
    emitConfirmationStateChanged: () => {},
    processMessage: async () => "msg-id",
    ...overrides,
  };
}

describe("handleConfirmationResponse canonical status sync", () => {
  beforeEach(() => {
    (
      globalThis as Record<string, unknown>
    ).__approvalConsumptionUseMockCanonicalStore = true;
    resolveCanonicalGuardianRequestMock.mockClear();
    resolveMock.mockClear();
  });

  afterAll(() => {
    (
      globalThis as Record<string, unknown>
    ).__approvalConsumptionUseMockCanonicalStore = false;
  });

  test("syncs canonical status to approved for allow decisions", () => {
    const conversationObj = {
      hasPendingConfirmation: (requestId: string) =>
        requestId === "req-confirm-allow",
      handleConfirmationResponse: mock(() => {}),
    };
    const { ctx } = createContext(makeConversation());
    ctx.conversations.set("conv-1", conversationObj as any);

    const msg: ConfirmationResponse = {
      type: "confirmation_response",
      requestId: "req-confirm-allow",
      decision: "always_allow",
    };

    handleConfirmationResponse(msg, ctx);

    expect(
      (conversationObj.handleConfirmationResponse as any).mock.calls.length,
    ).toBe(1);
    expect(
      (conversationObj.handleConfirmationResponse as any).mock.calls[0],
    ).toEqual([
      "req-confirm-allow",
      "always_allow",
      undefined,
      undefined,
      undefined,
      { source: "button" },
    ]);
    expect(resolveCanonicalGuardianRequestMock).toHaveBeenCalledWith(
      "req-confirm-allow",
      "pending",
      {
        status: "approved",
      },
    );
    expect(resolveMock).toHaveBeenCalledWith("req-confirm-allow");
  });
});

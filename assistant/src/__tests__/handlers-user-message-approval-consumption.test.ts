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

import type { ConfirmationResponse } from "../daemon/message-protocol.js";

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
    secretDetection: {},
  }),
  loadConfig: () => ({}),
  loadRawConfig: () => ({}),
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

import {
  clearConversations,
  setConversation,
} from "../daemon/conversation-store.js";
import { handleConfirmationResponse } from "../daemon/handlers/conversations.js";

describe("handleConfirmationResponse canonical status sync", () => {
  beforeEach(() => {
    clearConversations();
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
    setConversation("conv-1", conversationObj as any);

    const msg: ConfirmationResponse = {
      type: "confirmation_response",
      requestId: "req-confirm-allow",
      decision: "allow",
    };

    handleConfirmationResponse(msg);

    expect(
      (conversationObj.handleConfirmationResponse as any).mock.calls.length,
    ).toBe(1);
    expect(
      (conversationObj.handleConfirmationResponse as any).mock.calls[0],
    ).toEqual([
      "req-confirm-allow",
      "allow",
      undefined,
      undefined,
      undefined,
      { source: "button" },
    ]);
    // Canonical status sync is now handled inside Conversation.handleConfirmationResponse,
    // which this test mocks out — so the handler itself no longer calls resolveCanonicalGuardianRequest.
    expect(resolveCanonicalGuardianRequestMock).not.toHaveBeenCalled();
    expect(resolveMock).toHaveBeenCalledWith("req-confirm-allow");
  });
});

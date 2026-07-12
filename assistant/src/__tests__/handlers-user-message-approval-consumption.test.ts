/**
 * Tests for confirmation response handling (handleConfirmationResponse).
 *
 * The legacy handleUserMessage tests that previously lived here were removed
 * when conversation-user-message.ts was deleted. The approval-reply behavior they
 * tested now lives on the HTTP path and is covered by
 * conversation-routes-guardian-reply.test.ts, send-endpoint-busy.test.ts,
 * and http-user-message-parity.test.ts.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../config/env.js", () => ({ isHttpAuthDisabled: () => true }));

import type { ConfirmationResponse } from "../daemon/message-protocol.js";
import { createGuardianGatewaySim } from "./guardian-gateway-sim.js";

const resolveMock = mock(() => undefined as unknown);

// Sim-backed gateway client: `gatewaySim.state.decideCalls` records any
// guardian-request status writes the handler under test performs.
const gatewaySim = createGuardianGatewaySim();
mock.module(
  "../channels/gateway-guardian-requests.js",
  () => gatewaySim.module,
);

mock.module("../runtime/pending-interactions.js", () => ({
  register: mock(() => {}),
  getByConversation: mock(() => []),
  resolve: resolveMock,
}));

mock.module("../persistence/conversation-crud.js", () => ({
  addMessage: mock(async () => ({ id: "persisted-message-id" })),
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
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

const realLocalActorIdentity =
  await import("../runtime/local-actor-identity.js");
mock.module("../runtime/local-actor-identity.js", () => ({
  ...realLocalActorIdentity,
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
} from "../daemon/conversation-registry.js";
import { handleConfirmationResponse } from "../daemon/handlers/conversations.js";

describe("handleConfirmationResponse guardian status sync", () => {
  beforeEach(() => {
    clearConversations();
    gatewaySim.reset();
    resolveMock.mockClear();
  });

  test("delegates approval status sync for allow decisions", () => {
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
      {
        selectedPattern: undefined,
        selectedScope: undefined,
        emissionContext: { source: "button" },
      },
    ]);
    // Guardian-request status sync and pendingInteractions lifecycle are
    // owned by Conversation.handleConfirmationResponse (mocked above). The
    // IPC handler delegates fully and does not call either directly.
    expect(gatewaySim.state.decideCalls).toHaveLength(0);
    expect(resolveMock).not.toHaveBeenCalled();
  });
});

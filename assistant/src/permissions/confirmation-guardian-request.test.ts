/**
 * Tests for the confirmation → guardian-request promotion, including the
 * in-flight race: a confirmation resolved while the fire-and-forget gateway
 * create is still pending must not strand a pending tool_approval row.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const createCalls: Array<Record<string, unknown>> = [];
const expireCalls: string[] = [];
const bridgeCalls: Array<Record<string, unknown>> = [];
let confirmationPending = true;

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../daemon/conversation-registry.js", () => ({
  findConversation: () => ({
    assistantId: "self",
    trustContext: {
      sourceChannel: "telegram",
      requesterExternalUserId: "tg-user-1",
      requesterChatId: "tg-chat-1",
      guardianExternalUserId: "tg-guardian-1",
      guardianPrincipalId: "principal-1",
    },
    hasPendingConfirmation: () => confirmationPending,
  }),
}));

mock.module("../channels/gateway-guardian-requests.js", () => ({
  createGuardianRequest: async (params: Record<string, unknown>) => {
    createCalls.push(params);
    return { ...params, requestCode: "AB12CD" };
  },
  expireGuardianRequest: async (id: string) => {
    expireCalls.push(id);
  },
}));

mock.module("../runtime/confirmation-request-guardian-bridge.js", () => ({
  bridgeConfirmationRequestToGuardian: async (
    params: Record<string, unknown>,
  ) => {
    bridgeCalls.push(params);
  },
}));

import type { ServerMessage } from "../daemon/message-protocol.js";
import { createGuardianRequestForConfirmation } from "./confirmation-guardian-request.js";

const MSG = {
  type: "confirmation_request",
  requestId: "req-conf-1",
  toolName: "Bash",
  input: { command: "ls" },
  riskLevel: "medium",
} as unknown as ServerMessage & { type: "confirmation_request" };

describe("createGuardianRequestForConfirmation", () => {
  beforeEach(() => {
    createCalls.length = 0;
    expireCalls.length = 0;
    bridgeCalls.length = 0;
    confirmationPending = true;
  });

  test("creates the gateway row and bridges while the confirmation is pending", async () => {
    await createGuardianRequestForConfirmation(MSG, "conv-1");

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]).toMatchObject({
      id: "req-conf-1",
      kind: "tool_approval",
      guardianPrincipalId: "principal-1",
    });
    expect(expireCalls).toHaveLength(0);
    expect(bridgeCalls).toHaveLength(1);
  });

  test("expires the row and skips the bridge when the confirmation resolved mid-create", async () => {
    confirmationPending = false;

    await createGuardianRequestForConfirmation(MSG, "conv-1");

    expect(createCalls).toHaveLength(1);
    expect(expireCalls).toEqual(["req-conf-1"]);
    expect(bridgeCalls).toHaveLength(0);
  });
});

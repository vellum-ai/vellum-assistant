/**
 * Tests for the confirmation to guardian-request promotion, including the
 * in-flight race (a confirmation resolved while the fire-and-forget gateway
 * create is still pending must not strand a pending tool_approval row) and
 * the deadline, which is derived from the approval-window resolver rather
 * than restated as a constant.
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
  findConversation: () =>
    asConversation({
      assistantId: "self",
      trustContext: {
        trustClass: "trusted_contact",
        sourceChannel: "telegram",
        requesterExternalUserId: "tg-user-1",
        requesterChatId: "tg-chat-1",
        guardianExternalUserId: "tg-guardian-1",
        guardianPrincipalId: "principal-1",
      } satisfies TrustContext,
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

// Deliberately not 300_000, the resolver's default. A fixture on the default
// passes whether the deadline is read from the resolver or restated as a
// constant beside it; this value only matches if it is read.
const APPROVAL_WINDOW_MS = 900_000;

mock.module("../tools/tool-approval-handler.js", () => ({
  resolveInlineGrantWaitMs: () => APPROVAL_WINDOW_MS,
}));

import { asConversation } from "../__tests__/helpers/mock-conversation.js";
import type { AssistantEvent } from "../api/index.js";
import type { TrustContext } from "../daemon/trust-context-types.js";
import { createGuardianRequestForConfirmation } from "./confirmation-guardian-request.js";

const MSG = {
  type: "confirmation_request",
  requestId: "req-conf-1",
  toolName: "Bash",
  input: { command: "ls" },
  riskLevel: "medium",
} as unknown as AssistantEvent & { type: "confirmation_request" };

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

  test("takes the row deadline from the approval-window resolver", async () => {
    const before = Date.now();
    await createGuardianRequestForConfirmation(MSG, "conv-1");
    const after = Date.now();

    expect(createCalls).toHaveLength(1);
    const expiresAt = createCalls[0].expiresAt as number;

    // Bracketed against the clock either side of the call rather than compared
    // to a single Date.now(), so the assertion cannot flake on a slow tick.
    expect(expiresAt).toBeGreaterThanOrEqual(before + APPROVAL_WINDOW_MS);
    expect(expiresAt).toBeLessThanOrEqual(after + APPROVAL_WINDOW_MS);
  });

  test("expires the row and skips the bridge when the confirmation resolved mid-create", async () => {
    confirmationPending = false;

    await createGuardianRequestForConfirmation(MSG, "conv-1");

    expect(createCalls).toHaveLength(1);
    expect(expireCalls).toEqual(["req-conf-1"]);
    expect(bridgeCalls).toHaveLength(0);
  });
});

/**
 * Unit tests for the bootstrap deep-link intercept stage against the
 * gateway-backed session client.
 *
 * Covers: the happy-path /start gv_<token> handoff (resolve → bind →
 * fresh identity-bound session → delivery tracking; the mint revokes the
 * bootstrap session gateway-side), fall-through for unresolvable tokens,
 * ACL-threaded session reuse (no second gateway lookup), the
 * gateway-unreachable posture (handled "unavailable" response — never
 * fall-through to normal processing), and retryability: any failure before
 * the mint leaves the original session pending_bootstrap.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

// Gateway-backed session client (async IPC); throw toggles simulate an
// unreachable gateway per lifecycle call.
let bootstrapSessionForTest: Record<string, unknown> | null = null;
let resolveThrows = false;
let bindThrows = false;
let createThrows = false;
let updateDeliveryThrows = false;

const resolveCalls: unknown[][] = [];
const bindCalls: unknown[][] = [];
const updateStatusCalls: unknown[][] = [];
const createCalls: unknown[] = [];
const updateDeliveryCalls: unknown[][] = [];

mock.module("../../../channels/gateway-verification-sessions.js", () => ({
  resolveBootstrapToken: async (channel: string, token: string) => {
    if (resolveThrows) throw new Error("gateway unreachable");
    resolveCalls.push([channel, token]);
    return bootstrapSessionForTest;
  },
  bindSessionIdentity: async (...args: unknown[]) => {
    if (bindThrows) throw new Error("gateway unreachable");
    bindCalls.push(args);
  },
  updateSessionStatus: async (...args: unknown[]) => {
    updateStatusCalls.push(args);
  },
  createOutboundSession: async (params: unknown) => {
    if (createThrows) throw new Error("gateway unreachable");
    createCalls.push(params);
    return {
      sessionId: "new-session-1",
      secret: "654321",
      challengeHash: "hash-1",
      expiresAt: Date.now() + 600_000,
      ttlSeconds: 600,
    };
  },
  updateSessionDelivery: async (...args: unknown[]) => {
    if (updateDeliveryThrows) throw new Error("gateway unreachable");
    updateDeliveryCalls.push(args);
  },
}));

const telegramReplies: Array<{ chatId: string; text: string }> = [];
mock.module("../../../messaging/providers/telegram-bot/send.js", () => ({
  sendTelegramReply: async (chatId: string, text: string) => {
    telegramReplies.push({ chatId, text });
  },
}));

mock.module("../../verification-outbound-actions.js", () => ({
  RESEND_COOLDOWN_MS: 60_000,
}));

import type { VerificationSessionWire } from "../../../channels/gateway-verification-sessions.js";
import type { BootstrapInterceptParams } from "./bootstrap-intercept.js";
import { handleBootstrapIntercept } from "./bootstrap-intercept.js";

function makeParams(
  overrides: Partial<BootstrapInterceptParams> = {},
): BootstrapInterceptParams {
  return {
    isDuplicate: false,
    commandIntent: { type: "start", payload: "gv_token123" },
    rawSenderId: "user-42",
    canonicalAssistantId: "self",
    sourceChannel: "telegram",
    conversationExternalId: "chat-123",
    eventId: "event-1",
    ...overrides,
  };
}

beforeEach(() => {
  bootstrapSessionForTest = {
    id: "bootstrap-session-1",
    channel: "telegram",
    status: "pending_bootstrap",
  };
  resolveThrows = false;
  bindThrows = false;
  createThrows = false;
  updateDeliveryThrows = false;
  resolveCalls.length = 0;
  bindCalls.length = 0;
  updateStatusCalls.length = 0;
  createCalls.length = 0;
  updateDeliveryCalls.length = 0;
  telegramReplies.length = 0;
});

describe("handleBootstrapIntercept", () => {
  test("valid token binds identity, rotates the session, and returns bootstrap_bound", async () => {
    const result = await handleBootstrapIntercept(makeParams());

    expect(result).toEqual({
      accepted: true,
      duplicate: false,
      eventId: "event-1",
      verificationOutcome: "bootstrap_bound",
    });

    // Raw token (gv_ prefix stripped); hashing is gateway-side.
    expect(resolveCalls).toEqual([["telegram", "token123"]]);
    expect(bindCalls).toEqual([["bootstrap-session-1", "user-42", "chat-123"]]);
    // The mint revokes the bootstrap session gateway-side; no separate
    // status transition — that would make a mint failure unretryable.
    expect(updateStatusCalls).toHaveLength(0);
    expect(createCalls).toEqual([
      {
        channel: "telegram",
        expectedExternalUserId: "user-42",
        expectedChatId: "chat-123",
        identityBindingStatus: "bound",
        destinationAddress: "chat-123",
      },
    ]);
    expect(updateDeliveryCalls).toHaveLength(1);
    expect(updateDeliveryCalls[0][0]).toBe("new-session-1");
  });

  test("unresolvable token falls through to normal /start handling", async () => {
    bootstrapSessionForTest = null;

    const result = await handleBootstrapIntercept(makeParams());

    expect(result).toBeNull();
    expect(bindCalls).toHaveLength(0);
    expect(createCalls).toHaveLength(0);
  });

  test("non-pending_bootstrap session falls through", async () => {
    bootstrapSessionForTest = {
      id: "bootstrap-session-1",
      channel: "telegram",
      status: "consumed",
    };

    const result = await handleBootstrapIntercept(makeParams());

    expect(result).toBeNull();
    expect(bindCalls).toHaveLength(0);
  });

  test("non-bootstrap commands fall through untouched", async () => {
    expect(
      await handleBootstrapIntercept(
        makeParams({ commandIntent: { type: "start", payload: "iv_other" } }),
      ),
    ).toBeNull();
    expect(
      await handleBootstrapIntercept(makeParams({ isDuplicate: true })),
    ).toBeNull();
    expect(
      await handleBootstrapIntercept(makeParams({ rawSenderId: undefined })),
    ).toBeNull();
    expect(resolveCalls).toHaveLength(0);
  });

  test("gateway unreachable on token resolution returns a handled unavailable response — no fall-through", async () => {
    resolveThrows = true;

    const result = await handleBootstrapIntercept(makeParams());

    expect(result).toEqual({
      accepted: true,
      duplicate: false,
      eventId: "event-1",
      verificationOutcome: "bootstrap_unavailable",
    });
    expect(bindCalls).toHaveLength(0);
    expect(createCalls).toHaveLength(0);
    expect(telegramReplies).toHaveLength(1);
    expect(telegramReplies[0].text).toContain("tap the link again");
  });

  test("gateway unreachable on identity bind leaves the session pending_bootstrap and responds unavailable", async () => {
    bindThrows = true;

    const result = await handleBootstrapIntercept(makeParams());

    expect(result).toMatchObject({
      verificationOutcome: "bootstrap_unavailable",
    });
    // Nothing moved the session out of pending_bootstrap — re-tap retries.
    expect(updateStatusCalls).toHaveLength(0);
    expect(createCalls).toHaveLength(0);
    expect(telegramReplies).toHaveLength(1);
  });

  test("gateway unreachable on session creation leaves the session pending_bootstrap and responds unavailable", async () => {
    createThrows = true;

    const result = await handleBootstrapIntercept(makeParams());

    expect(result).toMatchObject({
      verificationOutcome: "bootstrap_unavailable",
    });
    // Bind ran but binding never changes status, so the token is still
    // resolvable and the deep link remains retryable.
    expect(bindCalls).toHaveLength(1);
    expect(updateStatusCalls).toHaveLength(0);
    expect(updateDeliveryCalls).toHaveLength(0);
    expect(telegramReplies).toHaveLength(1);
  });

  test("ACL-threaded session skips the second gateway lookup and completes the handoff", async () => {
    const result = await handleBootstrapIntercept(
      makeParams({
        validatedBootstrapSession: {
          id: "bootstrap-session-1",
          channel: "telegram",
          status: "pending_bootstrap",
        } as unknown as VerificationSessionWire,
      }),
    );

    expect(result).toMatchObject({ verificationOutcome: "bootstrap_bound" });
    expect(resolveCalls).toHaveLength(0);
    expect(bindCalls).toEqual([["bootstrap-session-1", "user-42", "chat-123"]]);
  });

  test("ACL-threaded session with a failing handoff still returns the handled unavailable response", async () => {
    bindThrows = true;

    const result = await handleBootstrapIntercept(
      makeParams({
        validatedBootstrapSession: {
          id: "bootstrap-session-1",
          channel: "telegram",
          status: "pending_bootstrap",
        } as unknown as VerificationSessionWire,
      }),
    );

    expect(result).toMatchObject({
      verificationOutcome: "bootstrap_unavailable",
    });
    expect(resolveCalls).toHaveLength(0);
    expect(telegramReplies).toHaveLength(1);
  });

  test("delivery-tracking failure after the code is sent does not unwind the bootstrap", async () => {
    updateDeliveryThrows = true;

    const result = await handleBootstrapIntercept(makeParams());

    expect(result).toMatchObject({ verificationOutcome: "bootstrap_bound" });
  });
});

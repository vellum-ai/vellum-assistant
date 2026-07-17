/**
 * Unit tests for the bootstrap deep-link intercept stage against the
 * gateway-backed session client.
 *
 * Covers: the happy-path /start gv_<token> handoff (resolve → bind →
 * fresh identity-bound session → delivery tracking; the mint revokes the
 * bootstrap session gateway-side), fall-through for unresolvable tokens,
 * ACL-threaded session reuse (no second gateway lookup), the
 * gateway-unreachable posture (handled "unavailable" response — never
 * fall-through to normal processing), retryability (any failure before the
 * mint leaves the original session pending_bootstrap), and the atomic claim:
 * a concurrent handoff that already consumed the token conflicts instead of
 * minting a second code.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { createGatewayVerificationSessionsStub } from "../../../__tests__/helpers/gateway-verification-sessions-stub.js";

// Gateway-backed session client (async IPC); throw toggles simulate an
// unreachable gateway per lifecycle call.
const gatewaySessions = createGatewayVerificationSessionsStub({
  mintResult: () => ({
    sessionId: "new-session-1",
    secret: "654321",
    challengeHash: "hash-1",
    expiresAt: Date.now() + 600_000,
    ttlSeconds: 600,
  }),
});
mock.module(
  "../../../channels/gateway-verification-sessions.js",
  () => gatewaySessions.module,
);

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
  gatewaySessions.reset();
  gatewaySessions.state.bootstrapSession = {
    id: "bootstrap-session-1",
    channel: "telegram",
    status: "pending_bootstrap",
  };
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
    expect(gatewaySessions.calls.resolveBootstrapToken).toEqual([
      ["telegram", "token123"],
    ]);
    expect(gatewaySessions.calls.bindSessionIdentity).toEqual([
      ["bootstrap-session-1", "user-42", "chat-123"],
    ]);
    // The mint revokes the bootstrap session gateway-side; no separate
    // status transition — that would make a mint failure unretryable.
    expect(gatewaySessions.calls.updateSessionStatus).toHaveLength(0);
    expect(gatewaySessions.calls.create).toEqual([
      {
        channel: "telegram",
        expectedExternalUserId: "user-42",
        expectedChatId: "chat-123",
        identityBindingStatus: "bound",
        destinationAddress: "chat-123",
        // Atomic gateway-side claim of the bootstrap session.
        requireSourceSessionPending: "bootstrap-session-1",
      },
    ]);
    expect(gatewaySessions.calls.updateSessionDelivery).toHaveLength(1);
    expect(gatewaySessions.calls.updateSessionDelivery[0][0]).toBe(
      "new-session-1",
    );
  });

  test("unresolvable token falls through to normal /start handling", async () => {
    gatewaySessions.state.bootstrapSession = null;

    const result = await handleBootstrapIntercept(makeParams());

    expect(result).toBeNull();
    expect(gatewaySessions.calls.bindSessionIdentity).toHaveLength(0);
    expect(gatewaySessions.calls.create).toHaveLength(0);
  });

  test("non-pending_bootstrap session falls through", async () => {
    gatewaySessions.state.bootstrapSession = {
      id: "bootstrap-session-1",
      channel: "telegram",
      status: "consumed",
    };

    const result = await handleBootstrapIntercept(makeParams());

    expect(result).toBeNull();
    expect(gatewaySessions.calls.bindSessionIdentity).toHaveLength(0);
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
    expect(gatewaySessions.calls.resolveBootstrapToken).toHaveLength(0);
  });

  test("gateway unreachable on token resolution returns a handled unavailable response — no fall-through", async () => {
    gatewaySessions.unreachable.resolveBootstrapToken = true;

    const result = await handleBootstrapIntercept(makeParams());

    expect(result).toEqual({
      accepted: true,
      duplicate: false,
      eventId: "event-1",
      verificationOutcome: "bootstrap_unavailable",
    });
    expect(gatewaySessions.calls.bindSessionIdentity).toHaveLength(0);
    expect(gatewaySessions.calls.create).toHaveLength(0);
    expect(telegramReplies).toHaveLength(1);
    expect(telegramReplies[0].text).toContain("tap the link again");
  });

  test("gateway unreachable on identity bind leaves the session pending_bootstrap and responds unavailable", async () => {
    gatewaySessions.unreachable.bindSessionIdentity = true;

    const result = await handleBootstrapIntercept(makeParams());

    expect(result).toMatchObject({
      verificationOutcome: "bootstrap_unavailable",
    });
    // Nothing moved the session out of pending_bootstrap — re-tap retries.
    expect(gatewaySessions.calls.updateSessionStatus).toHaveLength(0);
    expect(gatewaySessions.calls.create).toHaveLength(0);
    expect(telegramReplies).toHaveLength(1);
  });

  test("gateway unreachable on session creation leaves the session pending_bootstrap and responds unavailable", async () => {
    gatewaySessions.unreachable.createOutboundSessionConditional = true;

    const result = await handleBootstrapIntercept(makeParams());

    expect(result).toMatchObject({
      verificationOutcome: "bootstrap_unavailable",
    });
    // Bind ran but binding never changes status, so the token is still
    // resolvable and the deep link remains retryable.
    expect(gatewaySessions.calls.bindSessionIdentity).toHaveLength(1);
    expect(gatewaySessions.calls.updateSessionStatus).toHaveLength(0);
    expect(gatewaySessions.calls.updateSessionDelivery).toHaveLength(0);
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
    expect(gatewaySessions.calls.resolveBootstrapToken).toHaveLength(0);
    expect(gatewaySessions.calls.bindSessionIdentity).toEqual([
      ["bootstrap-session-1", "user-42", "chat-123"],
    ]);
  });

  test("ACL-threaded session with a failing handoff still returns the handled unavailable response", async () => {
    gatewaySessions.unreachable.bindSessionIdentity = true;

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
    expect(gatewaySessions.calls.resolveBootstrapToken).toHaveLength(0);
    expect(telegramReplies).toHaveLength(1);
  });

  test("losing the concurrent claim race returns a handled response without a second code", async () => {
    gatewaySessions.state.conflictReason = "source_session_not_pending";

    const result = await handleBootstrapIntercept(makeParams());

    // The winner already sent its code; the loser must not mint, reply, or
    // touch delivery tracking — and must not fall through.
    expect(result).toEqual({
      accepted: true,
      duplicate: false,
      eventId: "event-1",
      verificationOutcome: "bootstrap_already_claimed",
    });
    expect(gatewaySessions.calls.create).toHaveLength(1);
    expect(gatewaySessions.calls.updateSessionDelivery).toHaveLength(0);
    expect(telegramReplies).toHaveLength(0);
  });

  test("delivery-tracking failure after the code is sent does not unwind the bootstrap", async () => {
    gatewaySessions.unreachable.updateSessionDelivery = true;

    const result = await handleBootstrapIntercept(makeParams());

    expect(result).toMatchObject({ verificationOutcome: "bootstrap_bound" });
  });
});

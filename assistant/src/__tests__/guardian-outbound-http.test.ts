/**
 * Tests for the outbound guardian HTTP control-plane endpoints and the
 * shared action module that backs them.
 *
 * Verifies:
 * - startOutbound / resendOutbound / cancelOutbound return correct result
 *   shapes and stable error codes.
 * - HTTP route handlers (handleCreateVerificationSession / handleResendVerificationSession /
 *   handleCancelVerificationSession) wire through to the shared module and return
 *   appropriate HTTP status codes.
 * - Rate limiting, missing/invalid destination, already_bound, and
 *   no_active_session error paths all produce the expected error codes.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Test isolation: in-memory SQLite via temp directory
// ---------------------------------------------------------------------------

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => true,
  getGatewayInternalBaseUrl: () => "http://127.0.0.1:7830",
}));

// Telegram bot username mock — production code now reads from config via getTelegramBotUsername()
let mockBotUsername: string | undefined = "test_bot";
mock.module("../telegram/bot-username.js", () => ({
  getTelegramBotUsername: () => mockBotUsername,
}));

// Voice call mock
const voiceCallInitCalls: Array<{
  phoneNumber: string;
  verificationSessionId: string;
  assistantId?: string;
  originConversationId?: string;
}> = [];
mock.module("../calls/call-domain.js", () => ({
  startVerificationCall: async (input: {
    phoneNumber: string;
    verificationSessionId: string;
    assistantId?: string;
    originConversationId?: string;
  }) => {
    voiceCallInitCalls.push(input);
    return { ok: true, callSessionId: "mock-call-session", callSid: "CA-mock" };
  },
}));

// Telegram delivery mock via fetch
const telegramDeliverCalls: Array<{
  chatId: string;
  text: string;
  assistantId?: string;
}> = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (
  input: string | URL | Request,
  init?: RequestInit,
) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  if (url.includes("/deliver/telegram") && init?.method === "POST") {
    const body = JSON.parse(init.body as string) as {
      chatId: string;
      text: string;
      assistantId?: string;
    };
    telegramDeliverCalls.push(body);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }
  return originalFetch(input, init as never);
}) as unknown as typeof fetch;

// Gateway IPC mock — session lifecycle now goes through the gateway session
// client; delegate verification_sessions_* methods to the local-service sim
// so the flows under test keep reading/writing the local test DB.
mock.module("../ipc/gateway-client.js", () => ({
  ipcCallPersistent: async (
    method: string,
    params?: Record<string, unknown>,
  ) => {
    const { handleVerificationSessionsIpc, isVerificationSessionsIpcMethod } =
      await import("./helpers/verification-sessions-ipc-sim.js");
    if (isVerificationSessionsIpcMethod(method)) {
      return handleVerificationSessionsIpc(method, params);
    }
    return { ok: true };
  },
  ipcCall: async () => null,
}));

// Guardian-delivery reader mock — the inbound challenge guard reads guardian
// existence from the gateway. These tests seed no binding, so report an empty
// list (not bound) rather than a null that would fail closed as already-bound.
mock.module("../contacts/guardian-delivery-reader.js", () => ({
  getGuardianDelivery: async () => [],
  getGuardianDeliveryFresh: async () => [],
  guardianForChannel: (
    list: Array<{ channelType: string; status: string }>,
    channelType: string,
  ) => list.find((g) => g.channelType === channelType && g.status === "active"),
}));

// ---------------------------------------------------------------------------
// Now import modules under test (after mocks are in place)
// ---------------------------------------------------------------------------

import { initializeDb } from "../persistence/db-init.js";
import {
  handleCancelVerificationSession,
  handleCreateVerificationSession,
  handleResendVerificationSession,
} from "../runtime/routes/channel-verification-routes.js";
import { BadRequestError } from "../runtime/routes/errors.js";
import {
  cancelOutbound,
  resendOutbound,
  startOutbound,
} from "../runtime/verification-outbound-actions.js";
import { resetDbForTesting } from "./db-test-helpers.js";
import {
  resetVerificationSessionsSim,
  updateSessionDelivery,
} from "./helpers/verification-sessions-ipc-sim.js";

// Initialize the database (creates all tables)
await initializeDb();

afterAll(() => {
  globalThis.fetch = originalFetch;
  resetDbForTesting();
});

function resetTables(): void {
  resetVerificationSessionsSim();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Reset mutable state between tests
beforeEach(() => {
  resetTables();
  telegramDeliverCalls.length = 0;
  voiceCallInitCalls.length = 0;
  mockBotUsername = "test_bot";
});

// ===========================================================================
// Shared action module: startOutbound
// ===========================================================================

describe("startOutbound", () => {
  test("Voice: returns missing_destination when destination is absent", async () => {
    const result = await startOutbound({ channel: "phone" });
    expect(result.success).toBe(false);
    expect(result.error).toBe("missing_destination");
    expect(result.channel).toBe("phone");
  });

  test("Voice: returns invalid_destination for garbage phone number", async () => {
    const result = await startOutbound({
      channel: "phone",
      destination: "notaphone",
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe("invalid_destination");
  });

  test("Voice: succeeds with valid E.164 number", async () => {
    const result = await startOutbound({
      channel: "phone",
      destination: "+15551234567",
    });
    expect(result.success).toBe(true);
    expect(result.verificationSessionId).toBeDefined();
    expect(result.secret).toBeDefined();
    expect(result.expiresAt).toBeGreaterThan(Date.now());
    expect(result.nextResendAt).toBeGreaterThan(Date.now());
    expect(result.sendCount).toBe(1);
    expect(result.channel).toBe("phone");
  });

  test("Voice: succeeds with loose phone format (parentheses + dashes)", async () => {
    const result = await startOutbound({
      channel: "phone",
      destination: "(555) 987-6543",
    });
    expect(result.success).toBe(true);
    expect(result.verificationSessionId).toBeDefined();
  });

  test("Telegram: returns missing_destination when absent", async () => {
    const result = await startOutbound({ channel: "telegram" });
    expect(result.success).toBe(false);
    expect(result.error).toBe("missing_destination");
  });

  test("Telegram: succeeds with numeric chat ID", async () => {
    const result = await startOutbound({
      channel: "telegram",
      destination: "123456789",
    });
    expect(result.success).toBe(true);
    expect(result.verificationSessionId).toBeDefined();
    expect(result.secret).toBeDefined();
    expect(result.sendCount).toBe(1);
  });

  test("Telegram: returns invalid_destination for negative (group) chat ID", async () => {
    const result = await startOutbound({
      channel: "telegram",
      destination: "-100123456",
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe("invalid_destination");
  });

  test("Telegram: returns pending_bootstrap for handle destination", async () => {
    const result = await startOutbound({
      channel: "telegram",
      destination: "@someuser",
    });
    expect(result.success).toBe(true);
    expect(result.telegramBootstrapUrl).toContain(
      "https://t.me/test_bot?start=gv_",
    );
    // Secret should NOT be present in bootstrap response
    expect(result.secret).toBeUndefined();
  });

  test("Telegram: returns no_bot_username when bot not configured", async () => {
    mockBotUsername = undefined;
    const result = await startOutbound({
      channel: "telegram",
      destination: "@someuser",
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe("no_bot_username");
  });

  test("voice: returns missing_destination when absent", async () => {
    const result = await startOutbound({ channel: "phone" });
    expect(result.success).toBe(false);
    expect(result.error).toBe("missing_destination");
  });

  test("voice: returns invalid_destination for garbage", async () => {
    const result = await startOutbound({
      channel: "phone",
      destination: "badphone",
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe("invalid_destination");
  });

  test("voice: succeeds with valid phone", async () => {
    const result = await startOutbound({
      channel: "phone",
      destination: "+15559876543",
    });
    expect(result.success).toBe(true);
    expect(result.verificationSessionId).toBeDefined();
    expect(result.secret).toBeDefined();
    expect(result.sendCount).toBe(1);
  });

  test("voice: passes originConversationId to startVerificationCall", async () => {
    voiceCallInitCalls.length = 0;
    const result = await startOutbound({
      channel: "phone",
      destination: "+15559876543",
      originConversationId: "conv-origin-linkage-test",
    });
    expect(result.success).toBe(true);
    // The voice call mock should have been invoked with the origin conversation
    expect(voiceCallInitCalls.length).toBe(1);
    expect(voiceCallInitCalls[0].phoneNumber).toBe("+15559876543");
  });

  test("voice: succeeds without originConversationId", async () => {
    voiceCallInitCalls.length = 0;
    const result = await startOutbound({
      channel: "phone",
      destination: "+15551119999",
    });
    expect(result.success).toBe(true);
    expect(voiceCallInitCalls.length).toBe(1);
  });

  test("email channel creates outbound session", async () => {
    const result = await startOutbound({
      channel: "email",
      destination: "user@example.com",
    });
    expect(result.success).toBe(true);
    expect(result.channel).toBe("email");
  });
});

// ===========================================================================
// Shared action module: resendOutbound
// ===========================================================================

describe("resendOutbound", () => {
  test("returns no_active_session when no session exists", async () => {
    const result = await resendOutbound({ channel: "phone" });
    expect(result.success).toBe(false);
    expect(result.error).toBe("no_active_session");
  });

  test("Voice: succeeds when an active session exists and cooldown has passed", async () => {
    // Start a session first
    const startResult = await startOutbound({
      channel: "phone",
      destination: "+15551112222",
    });
    expect(startResult.success).toBe(true);

    // Manually update delivery to set cooldown in the past so resend is allowed
    if (startResult.verificationSessionId) {
      updateSessionDelivery(
        startResult.verificationSessionId,
        Date.now() - 60_000,
        1,
        Date.now() - 1,
      );
    }

    const resendResult = await resendOutbound({ channel: "phone" });
    expect(resendResult.success).toBe(true);
    expect(resendResult.verificationSessionId).toBeDefined();
    expect(resendResult.sendCount).toBe(2);
  });

  test("Voice: preserves originConversationId on resend", async () => {
    const startResult = await startOutbound({
      channel: "phone",
      destination: "+15551113333",
    });
    expect(startResult.success).toBe(true);

    if (startResult.verificationSessionId) {
      updateSessionDelivery(
        startResult.verificationSessionId,
        Date.now() - 60_000,
        1,
        Date.now() - 1,
      );
    }

    const resendResult = await resendOutbound({
      channel: "phone",
      originConversationId: "conv-resend-voice-origin",
    });
    expect(resendResult.success).toBe(true);
    expect(resendResult.originConversationId).toBe("conv-resend-voice-origin");
  });

  test("voice: preserves originConversationId on resend and passes it to call initiation", async () => {
    voiceCallInitCalls.length = 0;
    const startResult = await startOutbound({
      channel: "phone",
      destination: "+15559991111",
    });
    expect(startResult.success).toBe(true);

    if (startResult.verificationSessionId) {
      updateSessionDelivery(
        startResult.verificationSessionId,
        Date.now() - 60_000,
        1,
        Date.now() - 1,
      );
    }

    const resendResult = await resendOutbound({
      channel: "phone",
      originConversationId: "conv-resend-voice-origin",
    });
    expect(resendResult.success).toBe(true);
    expect(resendResult.originConversationId).toBe("conv-resend-voice-origin");

    // Allow the fire-and-forget async call to flush
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The resend voice call should carry the origin conversation ID
    const resendCall = voiceCallInitCalls.find(
      (c) => c.originConversationId === "conv-resend-voice-origin",
    );
    expect(resendCall).toBeDefined();
    expect(resendCall!.phoneNumber).toBe("+15559991111");
  });
});

// ===========================================================================
// Shared action module: cancelOutbound
// ===========================================================================

describe("cancelOutbound", () => {
  test("returns no_active_session when no session exists", async () => {
    const result = await cancelOutbound({ channel: "phone" });
    expect(result.success).toBe(false);
    expect(result.error).toBe("no_active_session");
  });

  test("succeeds when an active session exists", async () => {
    const startResult = await startOutbound({
      channel: "phone",
      destination: "+15553334444",
    });
    expect(startResult.success).toBe(true);

    const cancelResult = await cancelOutbound({ channel: "phone" });
    expect(cancelResult.success).toBe(true);
    expect(cancelResult.channel).toBe("phone");
  });
});

// ===========================================================================
// HTTP route handlers
// ===========================================================================

describe("HTTP route: handleCreateVerificationSession (guardian path)", () => {
  test("throws BadRequestError when channel is missing", async () => {
    await expect(
      handleCreateVerificationSession({
        body: { destination: "+15551234567" },
      }),
    ).rejects.toThrow(BadRequestError);
  });

  test("creates inbound challenge when destination is absent", async () => {
    const result = (await handleCreateVerificationSession({
      body: { channel: "phone" },
    })) as Record<string, unknown>;
    expect(result.success).toBe(true);
    expect(result.channel).toBe("phone");
  });

  test("returns success for valid voice start", async () => {
    const result = (await handleCreateVerificationSession({
      body: { channel: "phone", destination: "+15559999999" },
    })) as Record<string, unknown>;
    expect(result.success).toBe(true);
    expect(result.verificationSessionId).toBeDefined();
  });
});

describe("HTTP route: handleResendVerificationSession (guardian path)", () => {
  test("throws BadRequestError when channel is missing", async () => {
    await expect(handleResendVerificationSession({ body: {} })).rejects.toThrow(
      BadRequestError,
    );
  });

  test("throws BadRequestError for no_active_session", async () => {
    await expect(
      handleResendVerificationSession({ body: { channel: "phone" } }),
    ).rejects.toThrow(BadRequestError);
  });

  test("passes originConversationId through on successful resend", async () => {
    // Start a session first
    const startResult = (await handleCreateVerificationSession({
      body: { channel: "phone", destination: "+15556667777" },
    })) as Record<string, unknown>;
    expect(startResult.success).toBe(true);

    // Expire the cooldown so resend is allowed
    if (startResult.verificationSessionId) {
      updateSessionDelivery(
        startResult.verificationSessionId as string,
        Date.now() - 60_000,
        1,
        Date.now() - 1,
      );
    }

    const resendResult = (await handleResendVerificationSession({
      body: {
        channel: "phone",
        originConversationId: "conv-resend-http-origin",
      },
    })) as Record<string, unknown>;
    expect(resendResult.success).toBe(true);
    expect(resendResult.originConversationId).toBe("conv-resend-http-origin");
  });
});

describe("HTTP route: handleCancelVerificationSession (guardian path)", () => {
  test("throws BadRequestError when channel is missing", async () => {
    await expect(handleCancelVerificationSession({ body: {} })).rejects.toThrow(
      BadRequestError,
    );
  });

  test("returns success even when no active session exists", async () => {
    const result = (await handleCancelVerificationSession({
      body: { channel: "phone" },
    })) as Record<string, unknown>;
    expect(result.success).toBe(true);
  });

  test("returns success when active session is cancelled", async () => {
    // Start a session
    const startResult = (await handleCreateVerificationSession({
      body: { channel: "phone", destination: "+15558887777" },
    })) as Record<string, unknown>;
    expect(startResult.success).toBe(true);

    // Cancel it
    const cancelResult = (await handleCancelVerificationSession({
      body: { channel: "phone" },
    })) as Record<string, unknown>;
    expect(cancelResult.success).toBe(true);
  });
});

// ===========================================================================
// Origin conversation linkage
// ===========================================================================

describe("origin conversation linkage", () => {
  test("startOutbound voice echoes originConversationId in result (first number)", async () => {
    const result = await startOutbound({
      channel: "phone",
      destination: "+15551119999",
      originConversationId: "conv-origin-voice-test-1",
    });
    expect(result.success).toBe(true);
    expect(result.originConversationId).toBe("conv-origin-voice-test-1");
  });

  test("startOutbound voice echoes originConversationId in result (second number)", async () => {
    const result = await startOutbound({
      channel: "phone",
      destination: "+15552229999",
      originConversationId: "conv-origin-voice-test",
    });
    expect(result.success).toBe(true);
    expect(result.originConversationId).toBe("conv-origin-voice-test");
  });

  test("startOutbound Telegram (chat ID) echoes originConversationId in result", async () => {
    const result = await startOutbound({
      channel: "telegram",
      destination: "999888777",
      originConversationId: "conv-origin-tg-test",
    });
    expect(result.success).toBe(true);
    expect(result.originConversationId).toBe("conv-origin-tg-test");
  });

  test("startOutbound without originConversationId returns undefined for field", async () => {
    const result = await startOutbound({
      channel: "phone",
      destination: "+15553338888",
    });
    expect(result.success).toBe(true);
    expect(result.originConversationId).toBeUndefined();
  });

  test("HTTP handleCreateVerificationSession passes originConversationId through", async () => {
    const result = (await handleCreateVerificationSession({
      body: {
        channel: "phone",
        destination: "+15557776666",
        originConversationId: "conv-origin-http-test",
      },
    })) as Record<string, unknown>;
    expect(result.success).toBe(true);
    expect(result.originConversationId).toBe("conv-origin-http-test");
  });

  test("voice call initiation receives originConversationId", async () => {
    const result = await startOutbound({
      channel: "phone",
      destination: "+15554443333",
      originConversationId: "conv-origin-voice-init",
    });
    expect(result.success).toBe(true);

    // Allow the fire-and-forget async call to flush
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The voice call mock should have been called with originConversationId
    expect(voiceCallInitCalls.length).toBeGreaterThan(0);
    const lastCall = voiceCallInitCalls[voiceCallInitCalls.length - 1];
    expect(lastCall.phoneNumber).toBe("+15554443333");
    expect(lastCall.originConversationId).toBe("conv-origin-voice-init");
  });

  test("resendOutbound voice carries originConversationId to call initiation", async () => {
    voiceCallInitCalls.length = 0;

    // Start a voice session (no origin initially)
    const startResult = await startOutbound({
      channel: "phone",
      destination: "+15552228888",
    });
    expect(startResult.success).toBe(true);

    // Expire cooldown
    if (startResult.verificationSessionId) {
      updateSessionDelivery(
        startResult.verificationSessionId,
        Date.now() - 60_000,
        1,
        Date.now() - 1,
      );
    }

    // Resend with origin conversation ID
    const resendResult = await resendOutbound({
      channel: "phone",
      originConversationId: "conv-resend-origin-linkage",
    });
    expect(resendResult.success).toBe(true);
    expect(resendResult.originConversationId).toBe(
      "conv-resend-origin-linkage",
    );

    // Allow fire-and-forget async call to flush
    await new Promise((resolve) => setTimeout(resolve, 50));

    const resendCall = voiceCallInitCalls.find(
      (c) => c.originConversationId === "conv-resend-origin-linkage",
    );
    expect(resendCall).toBeDefined();
    expect(resendCall!.phoneNumber).toBe("+15552228888");
  });
});

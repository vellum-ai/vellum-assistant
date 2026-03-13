/**
 * Tests for the deterministic verification control plane (M1).
 *
 * Verifies that:
 * 1. Verification control messages (code replies, /start gv_<token>) never invoke
 *    the normal message pipeline — they produce only template-driven copy.
 * 2. Call session mode metadata is persisted correctly for guardian verification calls.
 * 3. TwiML generation includes guardian verification parameters when relevant.
 * 4. Channel verification reply templates are non-empty and deterministic.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Test isolation: in-memory SQLite via temp directory
// ---------------------------------------------------------------------------

const testDir = mkdtempSync(join(tmpdir(), "deterministic-verify-test-"));

mock.module("../util/platform.js", () => ({
  getRootDir: () => testDir,
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => true,
  getGatewayInternalBaseUrl: () => "http://127.0.0.1:7830",
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { generateTwiML } from "../calls/twilio-routes.js";
import { initializeDb } from "../memory/db-init.js";
import {
  composeChannelVerifyReply,
  GUARDIAN_VERIFY_TEMPLATE_KEYS,
} from "../runtime/verification-templates.js";

// ---------------------------------------------------------------------------
// DB initialization
// ---------------------------------------------------------------------------

beforeEach(() => {
  initializeDb();
});

afterAll(() => {
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// ---------------------------------------------------------------------------
// Template tests: channel verification reply templates are deterministic
// ---------------------------------------------------------------------------

describe("Channel verification reply templates", () => {
  test("success template returns non-empty deterministic string", () => {
    const result = composeChannelVerifyReply(
      GUARDIAN_VERIFY_TEMPLATE_KEYS.CHANNEL_VERIFY_SUCCESS,
    );
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    // Calling again yields the same string (deterministic)
    expect(
      composeChannelVerifyReply(
        GUARDIAN_VERIFY_TEMPLATE_KEYS.CHANNEL_VERIFY_SUCCESS,
      ),
    ).toBe(result);
  });

  test("failure template returns non-empty deterministic string", () => {
    const result = composeChannelVerifyReply(
      GUARDIAN_VERIFY_TEMPLATE_KEYS.CHANNEL_VERIFY_FAILED,
    );
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  test("failure template uses provided failureReason", () => {
    const reason = "The verification code is invalid or has expired.";
    const result = composeChannelVerifyReply(
      GUARDIAN_VERIFY_TEMPLATE_KEYS.CHANNEL_VERIFY_FAILED,
      {
        failureReason: reason,
      },
    );
    expect(result).toBe(reason);
  });

  test("bootstrap bound template returns non-empty deterministic string", () => {
    const result = composeChannelVerifyReply(
      GUARDIAN_VERIFY_TEMPLATE_KEYS.CHANNEL_BOOTSTRAP_BOUND,
    );
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// TwiML generation: parameter propagation
// ---------------------------------------------------------------------------

describe("TwiML parameter propagation", () => {
  const defaultProfile = {
    language: "en-US",
    transcriptionProvider: "deepgram",
    ttsProvider: "google",
    voice: "en-US-Standard-A",
  };

  test("includes verificationSessionId as Parameter when provided", () => {
    const twiml = generateTwiML(
      "session-123",
      "wss://example.com/v1/calls/relay",
      null,
      defaultProfile,
      undefined,
      { verificationSessionId: "gv-session-456" },
    );
    expect(twiml).toContain('name="verificationSessionId"');
    expect(twiml).toContain('value="gv-session-456"');
    expect(twiml).toContain("<Parameter");
  });

  test("omits Parameter elements when no custom parameters", () => {
    const twiml = generateTwiML(
      "session-123",
      "wss://example.com/v1/calls/relay",
      null,
      defaultProfile,
    );
    expect(twiml).not.toContain("<Parameter");
  });

  test("omits Parameter elements when custom parameters is undefined", () => {
    const twiml = generateTwiML(
      "session-123",
      "wss://example.com/v1/calls/relay",
      null,
      defaultProfile,
      "token123",
      undefined,
    );
    expect(twiml).not.toContain("<Parameter");
  });
});

// ---------------------------------------------------------------------------
// Call session mode metadata: createCallSession persists callMode
// ---------------------------------------------------------------------------

describe("Call session mode metadata", () => {
  test("createCallSession persists callMode and verificationSessionId", async () => {
    // Dynamic import to avoid circular dependency issues
    const { createCallSession, getCallSession } =
      await import("../calls/call-store.js");
    const { getOrCreateConversation } =
      await import("../memory/conversation-key-store.js");

    const { conversationId } = getOrCreateConversation("test-conv-mode");
    const session = createCallSession({
      conversationId,
      provider: "twilio",
      fromNumber: "+15551234567",
      toNumber: "+15559876543",
      callMode: "verification",
      verificationSessionId: "gv-session-test",
    });

    expect(session.callMode).toBe("verification");
    expect(session.verificationSessionId).toBe("gv-session-test");

    // Verify it persists to DB
    const loaded = getCallSession(session.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.callMode).toBe("verification");
    expect(loaded!.verificationSessionId).toBe("gv-session-test");
  });

  test("createCallSession defaults callMode to null when not provided", async () => {
    const { createCallSession, getCallSession } =
      await import("../calls/call-store.js");
    const { getOrCreateConversation } =
      await import("../memory/conversation-key-store.js");

    const { conversationId } = getOrCreateConversation(
      "test-conv-mode-default",
    );
    const session = createCallSession({
      conversationId,
      provider: "twilio",
      fromNumber: "+15551234567",
      toNumber: "+15559876543",
    });

    expect(session.callMode).toBeNull();
    expect(session.verificationSessionId).toBeNull();

    const loaded = getCallSession(session.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.callMode).toBeNull();
    expect(loaded!.verificationSessionId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Guard test: verification commands must not reach processMessage
// ---------------------------------------------------------------------------

describe("Verification control messages are deterministic (guard)", () => {
  test("handleChannelInbound does not call processMessage for verification code replies", async () => {
    const { createHash } = await import("node:crypto");
    const { handleChannelInbound } =
      await import("../runtime/routes/inbound-message-handler.js");
    const { createInboundSession } =
      await import("../memory/channel-verification-sessions.js");

    // Set up a pending challenge
    const secret = "123456";
    const challengeHash = createHash("sha256").update(secret).digest("hex");
    createInboundSession({
      id: "challenge-guard-test",
      channel: "telegram",
      challengeHash,
      expiresAt: Date.now() + 600_000,
    });

    // Track whether processMessage was called
    let processMessageCalled = false;
    const processMessage = async () => {
      processMessageCalled = true;
      return { messageId: "msg-1" };
    };

    // Track channel replies
    const deliveredReplies: Array<{ chatId: string; text: string }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const _url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (init?.method === "POST" && init.body) {
        try {
          const body = JSON.parse(init.body as string);
          if (body.chatId && body.text) {
            deliveredReplies.push({ chatId: body.chatId, text: body.text });
          }
        } catch {
          /* not JSON */
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return originalFetch(input, init as never);
    }) as unknown as typeof fetch;

    try {
      const req = new Request("http://localhost/channels/inbound", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceChannel: "telegram",
          interface: "telegram",
          conversationExternalId: "chat-123",
          externalMessageId: `msg-guard-${Date.now()}`,
          content: secret,
          actorExternalId: "user-123",
          actorDisplayName: "Test User",
          replyCallbackUrl: "http://localhost/callback",
        }),
      });

      const response = await handleChannelInbound(req, processMessage);
      const body = (await response.json()) as Record<string, unknown>;

      // Verification should have been handled
      expect(body.verificationOutcome).toBeDefined();

      // processMessage must NOT have been called — this is the guard
      expect(processMessageCalled).toBe(false);

      // A deterministic reply should have been delivered
      expect(deliveredReplies.length).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("handleChannelInbound does not call processMessage for /start gv_<token> bootstrap commands", async () => {
    const { createHash, randomBytes } = await import("node:crypto");
    const { handleChannelInbound } =
      await import("../runtime/routes/inbound-message-handler.js");
    const { createOutboundSession } =
      await import("../runtime/channel-verification-service.js");

    // Generate a bootstrap token and create a pending_bootstrap session
    const bootstrapToken = randomBytes(16).toString("hex");
    const bootstrapTokenHash = createHash("sha256")
      .update(bootstrapToken)
      .digest("hex");

    createOutboundSession({
      channel: "telegram",
      identityBindingStatus: "pending_bootstrap",
      destinationAddress: "test_user",
      bootstrapTokenHash,
    });

    // Track whether processMessage was called
    let processMessageCalled = false;
    const processMessage = async () => {
      processMessageCalled = true;
      return { messageId: "msg-1" };
    };

    // Track channel replies (the handler delivers the verification code via fetch)
    const deliveredReplies: Array<{ chatId: string; text: string }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const _url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (init?.method === "POST" && init.body) {
        try {
          const body = JSON.parse(init.body as string);
          if (body.chatId && body.text) {
            deliveredReplies.push({ chatId: body.chatId, text: body.text });
          }
        } catch {
          /* not JSON */
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return originalFetch(input, init as never);
    }) as unknown as typeof fetch;

    try {
      const req = new Request("http://localhost/channels/inbound", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceChannel: "telegram",
          interface: "telegram",
          conversationExternalId: "chat-bootstrap-123",
          externalMessageId: `msg-bootstrap-${Date.now()}`,
          content: `/start gv_${bootstrapToken}`,
          actorExternalId: "user-bootstrap-123",
          actorDisplayName: "Bootstrap User",
          replyCallbackUrl: "http://localhost/callback",
          sourceMetadata: {
            commandIntent: { type: "start", payload: `gv_${bootstrapToken}` },
          },
        }),
      });

      const response = await handleChannelInbound(req, processMessage);
      const body = (await response.json()) as Record<string, unknown>;

      // Bootstrap should have been handled deterministically
      expect(body.verificationOutcome).toBe("bootstrap_bound");
      expect(body.accepted).toBe(true);

      // processMessage must NOT have been called — deterministic handling
      expect(processMessageCalled).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("handleChannelInbound does not allow blocked members to bootstrap with /start gv_<token>", async () => {
    const { createHash, randomBytes } = await import("node:crypto");
    const { handleChannelInbound } =
      await import("../runtime/routes/inbound-message-handler.js");
    const { createOutboundSession } =
      await import("../runtime/channel-verification-service.js");
    const { upsertContactChannel } =
      await import("../contacts/contacts-write.js");

    const blockedIdentity = {
      sourceChannel: "telegram",
      externalUserId: "user-blocked-bootstrap",
      externalChatId: "chat-blocked-bootstrap",
      displayName: "Blocked Bootstrap User",
      status: "blocked",
      policy: "deny",
    } as const;
    upsertContactChannel(blockedIdentity);

    const bootstrapToken = randomBytes(16).toString("hex");
    const bootstrapTokenHash = createHash("sha256")
      .update(bootstrapToken)
      .digest("hex");

    createOutboundSession({
      channel: "telegram",
      identityBindingStatus: "pending_bootstrap",
      destinationAddress: blockedIdentity.externalUserId,
      bootstrapTokenHash,
    });

    let processMessageCalled = false;
    const processMessage = async () => {
      processMessageCalled = true;
      return { messageId: "msg-1" };
    };

    const req = new Request("http://localhost/channels/inbound", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceChannel: "telegram",
        interface: "telegram",
        conversationExternalId: blockedIdentity.externalChatId,
        externalMessageId: `msg-blocked-bootstrap-${Date.now()}`,
        content: `/start gv_${bootstrapToken}`,
        actorExternalId: blockedIdentity.externalUserId,
        actorDisplayName: blockedIdentity.displayName,
        sourceMetadata: {
          commandIntent: { type: "start", payload: `gv_${bootstrapToken}` },
        },
      }),
    });

    const response = await handleChannelInbound(req, processMessage);
    const body = (await response.json()) as Record<string, unknown>;

    expect(body.accepted).toBe(true);
    expect(body.denied).toBe(true);
    expect(body.reason).toBe("member_blocked");
    expect(body.verificationOutcome).toBeUndefined();
    expect(processMessageCalled).toBe(false);
  });
});

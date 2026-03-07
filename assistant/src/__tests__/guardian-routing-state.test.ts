import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../config/env.js", () => ({ isHttpAuthDisabled: () => true }));
import { eq } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Test isolation: in-memory SQLite via temp directory
// ---------------------------------------------------------------------------

const testDir = mkdtempSync(join(tmpdir(), "guardian-routing-state-test-"));

mock.module("../util/platform.js", () => ({
  getRootDir: () => testDir,
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getSocketPath: () => join(testDir, "test.sock"),
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

// Mock security check to always pass
mock.module("../security/secret-ingress.js", () => ({
  checkIngressForSecrets: () => ({ blocked: false }),
}));

import { upsertContact } from "../contacts/contact-store.js";
import { createGuardianBinding } from "../contacts/contacts-write.js";
import type { TrustContext } from "../daemon/session-runtime-assembly.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import * as deliveryCrud from "../memory/delivery-crud.js";
import { channelInboundEvents, messages } from "../memory/schema.js";
import { sweepFailedEvents } from "../runtime/channel-retry-sweep.js";
import { handleChannelInbound } from "../runtime/routes/channel-routes.js";
import {
  resolveRoutingState,
  resolveRoutingStateFromRuntime,
} from "../runtime/trust-context-resolver.js";

initializeDb();

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    /* best effort */
  }
});

function resetTables(): void {
  const db = getDb();
  db.run("DELETE FROM channel_inbound_events");
  db.run("DELETE FROM channel_guardian_approval_requests");
  db.run("DELETE FROM canonical_guardian_requests");
  db.run("DELETE FROM conversation_keys");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
  db.run("DELETE FROM external_conversation_bindings");
  db.run("DELETE FROM contact_channels");
  db.run("DELETE FROM contacts");
}

// ═══════════════════════════════════════════════════════════════════════════
// Unit tests: resolveRoutingState
// ═══════════════════════════════════════════════════════════════════════════

describe("resolveRoutingState", () => {
  test("guardian actors are always interactive and route-resolvable", () => {
    const ctx: TrustContext = {
      sourceChannel: "telegram",
      trustClass: "guardian",
      guardianExternalUserId: "guardian-123",
      guardianChatId: "chat-123",
    };
    const state = resolveRoutingState(ctx);
    expect(state).toEqual({
      canBeInteractive: true,
      guardianRouteResolvable: true,
      promptWaitingAllowed: true,
    });
  });

  test("guardian actors are interactive even without guardianExternalUserId", () => {
    // Edge case: guardian is chatting in their own chat, no separate binding needed
    const ctx: TrustContext = {
      sourceChannel: "telegram",
      trustClass: "guardian",
    };
    const state = resolveRoutingState(ctx);
    expect(state.canBeInteractive).toBe(true);
    expect(state.promptWaitingAllowed).toBe(true);
  });

  test("trusted contact with resolvable guardian route is interactive", () => {
    const ctx: TrustContext = {
      sourceChannel: "telegram",
      trustClass: "trusted_contact",
      guardianExternalUserId: "guardian-456",
      guardianChatId: "guardian-chat-456",
    };
    const state = resolveRoutingState(ctx);
    expect(state).toEqual({
      canBeInteractive: true,
      guardianRouteResolvable: true,
      promptWaitingAllowed: true,
    });
  });

  test("trusted contact without guardian route is NOT interactive (fail-fast)", () => {
    const ctx: TrustContext = {
      sourceChannel: "telegram",
      trustClass: "trusted_contact",
      // No guardianExternalUserId — no guardian binding for this channel
    };
    const state = resolveRoutingState(ctx);
    expect(state).toEqual({
      canBeInteractive: true,
      guardianRouteResolvable: false,
      promptWaitingAllowed: false,
    });
  });

  test("unknown actors are never interactive regardless of guardian route", () => {
    const withRoute: TrustContext = {
      sourceChannel: "telegram",
      trustClass: "unknown",
      guardianExternalUserId: "guardian-789",
    };
    const withoutRoute: TrustContext = {
      sourceChannel: "telegram",
      trustClass: "unknown",
    };

    expect(resolveRoutingState(withRoute).promptWaitingAllowed).toBe(false);
    expect(resolveRoutingState(withRoute).canBeInteractive).toBe(false);
    expect(resolveRoutingState(withoutRoute).promptWaitingAllowed).toBe(false);
  });
});

describe("resolveRoutingStateFromRuntime", () => {
  test("produces same result as resolveRoutingState for guardian runtime context", () => {
    const runtimeCtx = {
      sourceChannel: "telegram" as const,
      trustClass: "trusted_contact" as const,
      guardianExternalUserId: "guardian-rt-1",
    };
    const state = resolveRoutingStateFromRuntime(runtimeCtx);
    expect(state.promptWaitingAllowed).toBe(true);
    expect(state.guardianRouteResolvable).toBe(true);
  });

  test("trusted contact runtime context without guardian binding is not interactive", () => {
    const runtimeCtx = {
      sourceChannel: "telegram" as const,
      trustClass: "trusted_contact" as const,
      // No guardianExternalUserId
    };
    const state = resolveRoutingStateFromRuntime(runtimeCtx);
    expect(state.promptWaitingAllowed).toBe(false);
    expect(state.guardianRouteResolvable).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Integration tests: inbound message handler interactivity
// ═══════════════════════════════════════════════════════════════════════════

describe("inbound-message-handler trusted-contact interactivity", () => {
  beforeEach(() => {
    resetTables();
    // Insert a test contact so the contacts-based ACL lookup passes
    upsertContact({
      displayName: "Test User",
      channels: [
        {
          type: "telegram",
          address: "telegram-user-default",
          externalUserId: "telegram-user-default",
          status: "active",
          policy: "allow",
        },
      ],
    });
  });

  function makeInboundRequest(
    overrides: Record<string, unknown> = {},
  ): Request {
    return new Request("http://localhost/channels/inbound", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Gateway-Origin": "test-token",
      },
      body: JSON.stringify({
        sourceChannel: "telegram",
        interface: "telegram",
        conversationExternalId: "chat-123",
        externalMessageId: `msg-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 8)}`,
        content: "hello",
        actorExternalId: "telegram-user-default",
        replyCallbackUrl: "https://gateway.test/deliver/telegram",
        ...overrides,
      }),
    });
  }

  test("trusted contact with guardian binding gets interactive turn", async () => {
    // Create guardian binding in contacts table so the trust resolver finds it
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "guardian-user-for-tc",
      guardianDeliveryChatId: "guardian-chat-for-tc",
      guardianPrincipalId: "guardian-user-for-tc",
    });

    const processCalls: Array<{ options?: Record<string, unknown> }> = [];
    const processMessage = mock(
      async (
        conversationId: string,
        _content: string,
        _attachmentIds?: string[],
        options?: Record<string, unknown>,
      ) => {
        processCalls.push({ options });
        const messageId = `msg-tc-interactive-${Date.now()}`;
        const db = getDb();
        db.insert(messages)
          .values({
            id: messageId,
            conversationId,
            role: "user",
            content: JSON.stringify([{ type: "text", text: "hello" }]),
            createdAt: Date.now(),
          })
          .run();
        return { messageId };
      },
    );

    const req = makeInboundRequest({
      externalMessageId: `msg-tc-interactive-${Date.now()}`,
    });

    const res = await handleChannelInbound(
      req,
      processMessage as any,
      "test-token",
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.accepted).toBe(true);

    // Wait for background processing
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(processCalls.length).toBeGreaterThan(0);
    expect(processCalls[0].options?.isInteractive).toBe(true);
  });

  test("trusted contact WITHOUT guardian binding gets non-interactive turn (fail-fast)", async () => {
    // No guardian binding created — trusted contact has no guardian route
    // but findMember still returns an active member (trusted_contact trust class)

    const processCalls: Array<{ options?: Record<string, unknown> }> = [];
    const processMessage = mock(
      async (
        conversationId: string,
        _content: string,
        _attachmentIds?: string[],
        options?: Record<string, unknown>,
      ) => {
        processCalls.push({ options });
        const messageId = `msg-tc-noroute-${Date.now()}`;
        const db = getDb();
        db.insert(messages)
          .values({
            id: messageId,
            conversationId,
            role: "user",
            content: JSON.stringify([{ type: "text", text: "hello" }]),
            createdAt: Date.now(),
          })
          .run();
        return { messageId };
      },
    );

    const req = makeInboundRequest({
      externalMessageId: `msg-tc-noroute-${Date.now()}`,
    });

    const res = await handleChannelInbound(
      req,
      processMessage as any,
      "test-token",
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.accepted).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(processCalls.length).toBeGreaterThan(0);
    // Trusted contact without a guardian binding should NOT be interactive
    // to prevent dead-end 300s prompt waits
    expect(processCalls[0].options?.isInteractive).toBe(false);
  });

  test("guardian actors remain interactive regardless", async () => {
    // Guardian binding matches the sender — use contacts-first so trust resolver finds it
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "telegram-user-default",
      guardianDeliveryChatId: "chat-123",
      guardianPrincipalId: "telegram-user-default",
    });

    const processCalls: Array<{ options?: Record<string, unknown> }> = [];
    const processMessage = mock(
      async (
        conversationId: string,
        _content: string,
        _attachmentIds?: string[],
        options?: Record<string, unknown>,
      ) => {
        processCalls.push({ options });
        const messageId = `msg-guardian-${Date.now()}`;
        const db = getDb();
        db.insert(messages)
          .values({
            id: messageId,
            conversationId,
            role: "user",
            content: JSON.stringify([{ type: "text", text: "hello" }]),
            createdAt: Date.now(),
          })
          .run();
        return { messageId };
      },
    );

    const req = makeInboundRequest({
      externalMessageId: `msg-guardian-${Date.now()}`,
    });

    const res = await handleChannelInbound(
      req,
      processMessage as any,
      "test-token",
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.accepted).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(processCalls.length).toBeGreaterThan(0);
    expect(processCalls[0].options?.isInteractive).toBe(true);
  });

  test("unknown actors remain non-interactive (denied at gate)", async () => {
    // No contact record => non-member denied at the ACL gate,
    // which is the strongest form of "not interactive".
    const req = makeInboundRequest({
      externalMessageId: `msg-unknown-${Date.now()}`,
      actorExternalId: "unknown-user-no-member",
    });

    const res = await handleChannelInbound(req, undefined, "test-token");
    const body = (await res.json()) as Record<string, unknown>;
    // Unknown actors are ACL-denied: accepted but denied with reason
    expect(body.accepted).toBe(true);
    expect(body.denied).toBe(true);
    expect(body.reason).toBe("not_a_member");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Integration tests: channel-retry-sweep routing state
// ═══════════════════════════════════════════════════════════════════════════

describe("channel-retry-sweep routing state", () => {
  beforeEach(() => {
    resetTables();
  });

  function seedFailedEvent(
    trustClass: "guardian" | "trusted_contact" | "unknown",
    guardianExternalUserId?: string,
  ): string {
    const inbound = deliveryCrud.recordInbound(
      "telegram",
      `chat-${trustClass}`,
      `msg-${trustClass}-${Date.now()}`,
    );
    deliveryCrud.storePayload(inbound.eventId, {
      content: "retry me",
      sourceChannel: "telegram",
      interface: "telegram",
      trustCtx: {
        trustClass,
        sourceChannel: "telegram",
        requesterExternalUserId: "test-user",
        requesterChatId: `chat-${trustClass}`,
        ...(guardianExternalUserId ? { guardianExternalUserId } : {}),
      },
    });

    const db = getDb();
    db.update(channelInboundEvents)
      .set({
        processingStatus: "failed",
        processingAttempts: 1,
        retryAfter: Date.now() - 1,
      })
      .where(eq(channelInboundEvents.id, inbound.eventId))
      .run();

    return inbound.eventId;
  }

  test("trusted_contact with guardian binding replays as interactive", async () => {
    seedFailedEvent("trusted_contact", "guardian-for-sweep");
    let capturedOptions: { isInteractive?: boolean } | undefined;

    await sweepFailedEvents(
      async (conversationId, _content, _attachmentIds, options) => {
        capturedOptions = options as { isInteractive?: boolean };
        const messageId = `message-tc-sweep-${Date.now()}`;
        const db = getDb();
        db.insert(messages)
          .values({
            id: messageId,
            conversationId,
            role: "user",
            content: JSON.stringify([{ type: "text", text: "retry me" }]),
            createdAt: Date.now(),
          })
          .run();
        return { messageId };
      },
      undefined,
    );

    expect(capturedOptions?.isInteractive).toBe(true);
  });

  test("trusted_contact without guardian binding replays as non-interactive", async () => {
    seedFailedEvent("trusted_contact");
    let capturedOptions: { isInteractive?: boolean } | undefined;

    await sweepFailedEvents(
      async (conversationId, _content, _attachmentIds, options) => {
        capturedOptions = options as { isInteractive?: boolean };
        const messageId = `message-tc-no-binding-${Date.now()}`;
        const db = getDb();
        db.insert(messages)
          .values({
            id: messageId,
            conversationId,
            role: "user",
            content: JSON.stringify([{ type: "text", text: "retry me" }]),
            createdAt: Date.now(),
          })
          .run();
        return { messageId };
      },
      undefined,
    );

    expect(capturedOptions?.isInteractive).toBe(false);
  });

  test("guardian replays as interactive", async () => {
    seedFailedEvent("guardian", "guardian-self");
    let capturedOptions: { isInteractive?: boolean } | undefined;

    await sweepFailedEvents(
      async (conversationId, _content, _attachmentIds, options) => {
        capturedOptions = options as { isInteractive?: boolean };
        const messageId = `message-guardian-sweep-${Date.now()}`;
        const db = getDb();
        db.insert(messages)
          .values({
            id: messageId,
            conversationId,
            role: "user",
            content: JSON.stringify([{ type: "text", text: "retry me" }]),
            createdAt: Date.now(),
          })
          .run();
        return { messageId };
      },
      undefined,
    );

    expect(capturedOptions?.isInteractive).toBe(true);
  });

  test("unknown replays as non-interactive", async () => {
    seedFailedEvent("unknown");
    let capturedOptions: { isInteractive?: boolean } | undefined;

    await sweepFailedEvents(
      async (conversationId, _content, _attachmentIds, options) => {
        capturedOptions = options as { isInteractive?: boolean };
        const messageId = `message-unknown-sweep-${Date.now()}`;
        const db = getDb();
        db.insert(messages)
          .values({
            id: messageId,
            conversationId,
            role: "user",
            content: JSON.stringify([{ type: "text", text: "retry me" }]),
            createdAt: Date.now(),
          })
          .run();
        return { messageId };
      },
      undefined,
    );

    expect(capturedOptions?.isInteractive).toBe(false);
  });
});

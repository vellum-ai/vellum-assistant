/**
 * Socket-level tests for the verification_sessions_* lifecycle IPC routes.
 *
 * Each request travels over a real Unix-domain-socket round-trip against a
 * real (temp-dir) gateway DB, exercising the routes exactly as the daemon
 * relay hits them: schema validation on the server, session-store writes,
 * and wire-shaped responses. The key security property pinned here: secrets
 * are minted gateway-side and only their SHA-256 hashes are persisted.
 *
 * `verification_sessions_validate_consume` registration/schema is pinned
 * here; its validation, rate-limiting, and side-effect behavior is covered
 * by gateway/src/__tests__/verification-session-consume.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CreateInboundSessionIpcResponseSchema,
  CreateOutboundSessionIpcResponseSchema,
  VERIFICATION_SESSIONS_IPC_METHODS,
  ValidateConsumeSessionIpcResponseSchema,
  VerificationSessionSchema,
  hashVerificationSecret,
} from "@vellumai/gateway-client";
import { eq } from "drizzle-orm";

import "../../__tests__/test-preload.js";
import {
  getGatewayDb,
  initGatewayDb,
  resetGatewayDb,
} from "../../db/connection.js";
import { channelVerificationSessions } from "../../db/schema.js";
import { verificationSessionRoutes } from "../verification-session-handlers.js";
import { GatewayIpcServer } from "../server.js";

const METHODS = VERIFICATION_SESSIONS_IPC_METHODS;

let server: GatewayIpcServer;
let socketDir: string;
let prevEnv: string | undefined;
let reqSeq = 0;

async function rpc(
  method: string,
  params?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const id = `req-${++reqSeq}`;
  const line = JSON.stringify({ id, method, params });
  return await new Promise((resolve, reject) => {
    const sock = connect(server.getSocketPath());
    let buf = "";
    sock.on("connect", () => sock.write(line + "\n"));
    sock.on("data", (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        sock.end();
        resolve(JSON.parse(buf.slice(0, nl)));
      }
    });
    sock.on("error", reject);
  });
}

/** rpc() for calls expected to succeed; returns the unwrapped result. */
async function call(
  method: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  const res = await rpc(method, params);
  if (res.error !== undefined) {
    throw new Error(`unexpected IPC error: ${String(res.error)}`);
  }
  return res.result;
}

function getRow(id: string) {
  return getGatewayDb()
    .select()
    .from(channelVerificationSessions)
    .where(eq(channelVerificationSessions.id, id))
    .get();
}

beforeEach(async () => {
  resetGatewayDb();
  await initGatewayDb();
  getGatewayDb().delete(channelVerificationSessions).run();

  socketDir = mkdtempSync(join(tmpdir(), "vellum-ipc-test-"));
  prevEnv = process.env.GATEWAY_IPC_SOCKET_DIR;
  process.env.GATEWAY_IPC_SOCKET_DIR = socketDir;
  // Disable the watchdog so the test has a single deterministic listener.
  server = new GatewayIpcServer(verificationSessionRoutes, {
    watchdogIntervalMs: 0,
  });
  server.start();
  // Wait for the listener to bind.
  const { existsSync } = await import("node:fs");
  for (let i = 0; i < 100 && !existsSync(server.getSocketPath()); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
});

afterEach(() => {
  server.stop();
  if (prevEnv === undefined) delete process.env.GATEWAY_IPC_SOCKET_DIR;
  else process.env.GATEWAY_IPC_SOCKET_DIR = prevEnv;
  rmSync(socketDir, { recursive: true, force: true });
  resetGatewayDb();
});

describe("route registration", () => {
  test("registers all 11 verification_sessions_* methods, each with a schema", () => {
    expect(verificationSessionRoutes.map((r) => r.method).sort()).toEqual(
      Object.values(METHODS).sort(),
    );
    for (const route of verificationSessionRoutes) {
      expect(route.schema).toBeDefined();
    }
  });
});

describe("verification_sessions_create_outbound", () => {
  test("mints a numeric secret whose SHA-256 matches the stored challenge_hash", async () => {
    const result = CreateOutboundSessionIpcResponseSchema.parse(
      await call(METHODS.createOutbound, {
        channel: "telegram",
        expectedExternalUserId: "tg-user-1",
        expectedChatId: "tg-chat-1",
        destinationAddress: "@guardian",
      }),
    );

    expect(result.secret).toMatch(/^\d{6}$/);
    expect(hashVerificationSecret(result.secret)).toBe(result.challengeHash);
    expect(result.ttlSeconds).toBe(600);

    // Only the hash is persisted — the raw secret never touches the DB.
    const row = getRow(result.sessionId);
    expect(row?.challengeHash).toBe(result.challengeHash);
    expect(row?.status).toBe("awaiting_response");
    expect(JSON.stringify(row)).not.toContain(result.secret);
  });

  test("honors codeDigits for bound-identity sessions", async () => {
    const result = CreateOutboundSessionIpcResponseSchema.parse(
      await call(METHODS.createOutbound, {
        channel: "phone",
        expectedPhoneE164: "+15555550123",
        codeDigits: 4,
      }),
    );
    expect(result.secret).toMatch(/^\d{4}$/);
    expect(getRow(result.sessionId)?.codeDigits).toBe(4);
  });

  test("pending_bootstrap sessions get a 32-byte hex secret", async () => {
    const result = CreateOutboundSessionIpcResponseSchema.parse(
      await call(METHODS.createOutbound, {
        channel: "telegram",
        identityBindingStatus: "pending_bootstrap",
        bootstrapTokenHash: hashVerificationSecret("raw-bootstrap-token"),
      }),
    );
    expect(result.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(hashVerificationSecret(result.secret)).toBe(result.challengeHash);

    const row = getRow(result.sessionId);
    expect(row?.status).toBe("pending_bootstrap");
    expect(row?.identityBindingStatus).toBe("pending_bootstrap");
  });

  test("uses a caller-supplied sessionId when provided", async () => {
    const result = CreateOutboundSessionIpcResponseSchema.parse(
      await call(METHODS.createOutbound, {
        channel: "telegram",
        sessionId: "pre-minted-id",
      }),
    );
    expect(result.sessionId).toBe("pre-minted-id");
    expect(getRow("pre-minted-id")).toBeDefined();
  });

  test("requireSourceSessionPending: stale bootstrap claim conflicts without revoking the winner's session", async () => {
    // The bootstrap session both concurrent /start handlers resolved.
    const bootstrap = CreateOutboundSessionIpcResponseSchema.parse(
      await call(METHODS.createOutbound, {
        channel: "telegram",
        identityBindingStatus: "pending_bootstrap",
        bootstrapTokenHash: hashVerificationSecret("deep-link-token"),
      }),
    );

    // Winner mints first: the guard passes and the mint revokes the
    // bootstrap session in the same synchronous section.
    const winner = CreateOutboundSessionIpcResponseSchema.parse(
      await call(METHODS.createOutbound, {
        channel: "telegram",
        expectedExternalUserId: "tg-user-1",
        expectedChatId: "tg-chat-1",
        identityBindingStatus: "bound",
        requireSourceSessionPending: bootstrap.sessionId,
      }),
    );
    expect(getRow(bootstrap.sessionId)?.status).toBe("revoked");
    expect(getRow(winner.sessionId)?.status).toBe("awaiting_response");

    // Loser's overlapping mint: source no longer pending_bootstrap →
    // conflict, no new row, winner's session untouched.
    const rowsBefore = getGatewayDb()
      .select()
      .from(channelVerificationSessions)
      .all().length;
    const loser = await call(METHODS.createOutbound, {
      channel: "telegram",
      expectedExternalUserId: "tg-user-1",
      expectedChatId: "tg-chat-1",
      identityBindingStatus: "bound",
      requireSourceSessionPending: bootstrap.sessionId,
    });
    expect(loser).toEqual({
      conflict: true,
      reason: "source_session_not_pending",
    });
    expect(getRow(winner.sessionId)?.status).toBe("awaiting_response");
    expect(
      getGatewayDb().select().from(channelVerificationSessions).all(),
    ).toHaveLength(rowsBefore);
  });

  test("requireSourceSessionPending: unknown or cross-channel source conflicts", async () => {
    expect(
      await call(METHODS.createOutbound, {
        channel: "telegram",
        requireSourceSessionPending: "no-such-session",
      }),
    ).toEqual({ conflict: true, reason: "source_session_not_pending" });

    const other = CreateOutboundSessionIpcResponseSchema.parse(
      await call(METHODS.createOutbound, {
        channel: "slack",
        identityBindingStatus: "pending_bootstrap",
      }),
    );
    expect(
      await call(METHODS.createOutbound, {
        channel: "telegram",
        requireSourceSessionPending: other.sessionId,
      }),
    ).toEqual({ conflict: true, reason: "source_session_not_pending" });
  });

  test("ifNoneActive: conflicts when an active session exists, without minting or revoking it", async () => {
    const first = CreateOutboundSessionIpcResponseSchema.parse(
      await call(METHODS.createOutbound, {
        channel: "telegram",
        expectedExternalUserId: "tg-user-1",
        expectedChatId: "tg-chat-1",
      }),
    );

    const second = await call(METHODS.createOutbound, {
      channel: "telegram",
      expectedExternalUserId: "tg-user-2",
      expectedChatId: "tg-chat-2",
      ifNoneActive: true,
    });
    expect(second).toEqual({
      conflict: true,
      reason: "active_session_exists",
    });

    // The first activation's code is still redeemable.
    expect(getRow(first.sessionId)?.status).toBe("awaiting_response");
    expect(
      getGatewayDb().select().from(channelVerificationSessions).all(),
    ).toHaveLength(1);
  });

  test("ifNoneActive: mints normally when the channel has no active session", async () => {
    const result = CreateOutboundSessionIpcResponseSchema.parse(
      await call(METHODS.createOutbound, {
        channel: "telegram",
        expectedChatId: "tg-chat-1",
        ifNoneActive: true,
      }),
    );
    expect(getRow(result.sessionId)?.status).toBe("awaiting_response");
  });

  test("ifNoneActiveForExternalUserId: conflicts on same sender, supersedes a different sender", async () => {
    const first = CreateOutboundSessionIpcResponseSchema.parse(
      await call(METHODS.createOutbound, {
        channel: "slack",
        expectedExternalUserId: "slack-user-1",
        expectedChatId: "slack-user-1",
      }),
    );

    // Same sender: conflict; the winner's code survives untouched.
    expect(
      await call(METHODS.createOutbound, {
        channel: "slack",
        expectedExternalUserId: "slack-user-1",
        expectedChatId: "slack-user-1",
        ifNoneActiveForExternalUserId: "slack-user-1",
      }),
    ).toEqual({ conflict: true, reason: "active_session_exists" });
    expect(getRow(first.sessionId)?.status).toBe("awaiting_response");

    // Different sender: supersedes (revoke-prior semantics apply).
    const second = CreateOutboundSessionIpcResponseSchema.parse(
      await call(METHODS.createOutbound, {
        channel: "slack",
        expectedExternalUserId: "slack-user-2",
        expectedChatId: "slack-user-2",
        ifNoneActiveForExternalUserId: "slack-user-2",
      }),
    );
    expect(getRow(second.sessionId)?.status).toBe("awaiting_response");
    expect(getRow(first.sessionId)?.status).toBe("revoked");
  });
});

describe("verification_sessions_create_inbound", () => {
  test("mints a hex secret, persists only the hash, returns the session DTO", async () => {
    const result = CreateInboundSessionIpcResponseSchema.parse(
      await call(METHODS.createInbound, {
        channel: "telegram",
        sourceConversationId: "conv-1",
      }),
    );

    expect(result.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(result.verifyCommand).toBe(result.secret);
    expect(result.ttlSeconds).toBe(600);
    expect(result.session.status).toBe("pending");
    expect(result.session.sourceConversationId).toBe("conv-1");
    expect(result.session.challengeHash).toBe(
      hashVerificationSecret(result.secret),
    );

    const row = getRow(result.session.id);
    expect(row?.challengeHash).toBe(result.session.challengeHash);
    expect(JSON.stringify(row)).not.toContain(result.secret);
  });
});

describe("read routes: get_pending / find_active / resolve_bootstrap", () => {
  test("get_pending returns the pending inbound session, null otherwise", async () => {
    expect(await call(METHODS.getPending, { channel: "telegram" })).toBeNull();

    const created = CreateInboundSessionIpcResponseSchema.parse(
      await call(METHODS.createInbound, { channel: "telegram" }),
    );

    const found = VerificationSessionSchema.parse(
      await call(METHODS.getPending, { channel: "telegram" }),
    );
    expect(found).toEqual(created.session);

    // Outbound sessions are not visible to get_pending, and other channels
    // stay isolated.
    expect(await call(METHODS.getPending, { channel: "slack" })).toBeNull();
  });

  test("find_active returns the outbound session, scoped by channel", async () => {
    expect(await call(METHODS.findActive, { channel: "telegram" })).toBeNull();

    const created = CreateOutboundSessionIpcResponseSchema.parse(
      await call(METHODS.createOutbound, {
        channel: "telegram",
        expectedChatId: "chat-1",
      }),
    );

    const found = VerificationSessionSchema.parse(
      await call(METHODS.findActive, { channel: "telegram" }),
    );
    expect(found.id).toBe(created.sessionId);
    expect(found.status).toBe("awaiting_response");

    expect(await call(METHODS.findActive, { channel: "phone" })).toBeNull();
  });

  test("resolve_bootstrap hashes the raw token gateway-side", async () => {
    const rawToken = "raw-deep-link-token";
    const created = CreateOutboundSessionIpcResponseSchema.parse(
      await call(METHODS.createOutbound, {
        channel: "telegram",
        identityBindingStatus: "pending_bootstrap",
        bootstrapTokenHash: hashVerificationSecret(rawToken),
      }),
    );

    const resolved = VerificationSessionSchema.parse(
      await call(METHODS.resolveBootstrap, {
        channel: "telegram",
        token: rawToken,
      }),
    );
    expect(resolved.id).toBe(created.sessionId);

    expect(
      await call(METHODS.resolveBootstrap, {
        channel: "telegram",
        token: "wrong-token",
      }),
    ).toBeNull();
  });
});

describe("mutation routes: bind / update_status / update_delivery / revoke", () => {
  test("bind_identity binds the expected identity and flips to bound", async () => {
    const created = CreateOutboundSessionIpcResponseSchema.parse(
      await call(METHODS.createOutbound, {
        channel: "telegram",
        identityBindingStatus: "pending_bootstrap",
      }),
    );

    const ack = await call(METHODS.bindIdentity, {
      sessionId: created.sessionId,
      externalUserId: "tg-user-9",
      chatId: "tg-chat-9",
    });
    expect(ack).toEqual({ ok: true });

    const row = getRow(created.sessionId);
    expect(row?.expectedExternalUserId).toBe("tg-user-9");
    expect(row?.expectedChatId).toBe("tg-chat-9");
    expect(row?.identityBindingStatus).toBe("bound");
  });

  test("update_status transitions the session and records the consumer", async () => {
    const created = CreateOutboundSessionIpcResponseSchema.parse(
      await call(METHODS.createOutbound, { channel: "telegram" }),
    );

    const ack = await call(METHODS.updateStatus, {
      sessionId: created.sessionId,
      status: "consumed",
      consumedByExternalUserId: "tg-user-2",
      consumedByChatId: "tg-chat-2",
    });
    expect(ack).toEqual({ ok: true });

    const row = getRow(created.sessionId);
    expect(row?.status).toBe("consumed");
    expect(row?.consumedByExternalUserId).toBe("tg-user-2");
    expect(row?.consumedByChatId).toBe("tg-chat-2");
  });

  test("update_delivery + count_recent_sends round-trip", async () => {
    const created = CreateOutboundSessionIpcResponseSchema.parse(
      await call(METHODS.createOutbound, {
        channel: "phone",
        expectedPhoneE164: "+15555550142",
        destinationAddress: "+15555550142",
      }),
    );

    const before = await call(METHODS.countRecentSends, {
      channel: "phone",
      destinationAddress: "+15555550142",
      windowMs: 60_000,
    });
    expect(before).toEqual({ count: 0 });

    const sentAt = Date.now();
    const ack = await call(METHODS.updateDelivery, {
      sessionId: created.sessionId,
      lastSentAt: sentAt,
      sendCount: 1,
      nextResendAt: sentAt + 30_000,
    });
    expect(ack).toEqual({ ok: true });

    const row = getRow(created.sessionId);
    expect(row?.lastSentAt).toBe(sentAt);
    expect(row?.sendCount).toBe(1);
    expect(row?.nextResendAt).toBe(sentAt + 30_000);

    const after = await call(METHODS.countRecentSends, {
      channel: "phone",
      destinationAddress: "+15555550142",
      windowMs: 60_000,
    });
    expect(after).toEqual({ count: 1 });
  });

  test("revoke_pending revokes the pending inbound session", async () => {
    const created = CreateInboundSessionIpcResponseSchema.parse(
      await call(METHODS.createInbound, { channel: "telegram" }),
    );

    const ack = await call(METHODS.revokePending, { channel: "telegram" });
    expect(ack).toEqual({ ok: true });

    expect(await call(METHODS.getPending, { channel: "telegram" })).toBeNull();
    expect(getRow(created.session.id)?.status).toBe("revoked");
  });
});

describe("verification_sessions_validate_consume", () => {
  test("round-trip: wrong code fails generically; correct code consumes once", async () => {
    // Behavioral depth (side effects, rate limiting, ATL-514) is covered by
    // verification-session-consume.test.ts — this pins the wire shape.
    const created = CreateOutboundSessionIpcResponseSchema.parse(
      await call(METHODS.createOutbound, {
        channel: "telegram",
        expectedExternalUserId: "tg-user-1",
        expectedChatId: "tg-chat-1",
      }),
    );
    const actor = {
      channel: "telegram",
      actorExternalUserId: "tg-user-1",
      actorChatId: "tg-chat-1",
    };

    const bad = ValidateConsumeSessionIpcResponseSchema.parse(
      await call(METHODS.validateConsume, { ...actor, secret: "000000" }),
    );
    expect(bad).toEqual({ success: false, reason: "invalid_or_expired" });

    const ok = ValidateConsumeSessionIpcResponseSchema.parse(
      await call(METHODS.validateConsume, { ...actor, secret: created.secret }),
    );
    expect(ok).toEqual({ success: true, verificationType: "guardian" });

    const row = getRow(created.sessionId);
    expect(row?.status).toBe("consumed");
    expect(row?.consumedByExternalUserId).toBe("tg-user-1");

    // One-time code: the replay fails.
    const replay = ValidateConsumeSessionIpcResponseSchema.parse(
      await call(METHODS.validateConsume, { ...actor, secret: created.secret }),
    );
    expect(replay.success).toBe(false);
  });
});

describe("schema rejection", () => {
  test("malformed params → 400 BAD_REQUEST without touching the store", async () => {
    const badCalls: Array<[string, Record<string, unknown>]> = [
      [METHODS.createInbound, {}], // channel required
      [METHODS.createOutbound, { channel: "" }], // non-empty channel
      [METHODS.createOutbound, { channel: "telegram", codeDigits: 0 }],
      [METHODS.getPending, {}],
      [METHODS.resolveBootstrap, { channel: "telegram", token: "" }],
      [METHODS.bindIdentity, { sessionId: "s-1", externalUserId: "u" }],
      [METHODS.updateStatus, { sessionId: "s-1", status: "not-a-status" }],
      [METHODS.updateDelivery, { sessionId: "s-1", lastSentAt: 1 }],
      [
        METHODS.countRecentSends,
        { channel: "phone", destinationAddress: "+15555550142", windowMs: -1 },
      ],
      [METHODS.revokePending, { channel: 42 }],
      [METHODS.validateConsume, { channel: "phone", secret: "123456" }], // actor ids required
      [METHODS.validateConsume, { channel: "phone", secret: "" }],
    ];

    for (const [method, params] of badCalls) {
      const res = await rpc(method, params);
      expect(res.statusCode).toBe(400);
      expect(res.errorCode).toBe("BAD_REQUEST");
      expect(String(res.error)).toContain("Invalid params");
    }

    // Nothing was written by any of the rejected calls.
    const rows = getGatewayDb()
      .select()
      .from(channelVerificationSessions)
      .all();
    expect(rows).toHaveLength(0);
  });
});

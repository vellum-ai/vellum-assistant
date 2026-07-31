/**
 * Tests for m0013-verification-sessions-backfill.
 *
 * Verifies that assistant `channel_verification_sessions` rows are copied
 * into the gateway table with full field fidelity (in-flight sessions
 * survive an upgrade boot), that interceptable non-expired assistant rows
 * backfill as `revoked` when the gateway already holds a fresh interceptable
 * session on the channel, that `channel_guardian_rate_limits` rows are
 * copied only where the gateway has no row for the actor key (gateway wins
 * conflicts), that re-running is idempotent, that an already-dropped source
 * table yields "done", that IPC failure yields "skip" and retries, and that
 * the migration never writes back to the assistant DB. Uses the same
 * fake-assistant-DB + real in-memory gateway-DB pattern as the m0009 test.
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  mock,
} from "bun:test";

import "./test-preload.js";

// ── Fake assistant DB ───────────────────────────────────────────────────────

type FakeSession = {
  id: string;
  channel: string;
  challenge_hash: string;
  expires_at: number;
  status: string;
  source_conversation_id: string | null;
  consumed_by_external_user_id: string | null;
  consumed_by_chat_id: string | null;
  expected_external_user_id: string | null;
  expected_chat_id: string | null;
  expected_phone_e164: string | null;
  identity_binding_status: string | null;
  destination_address: string | null;
  last_sent_at: number | null;
  send_count: number | null;
  next_resend_at: number | null;
  code_digits: number | null;
  max_attempts: number | null;
  verification_purpose: string | null;
  bootstrap_token_hash: string | null;
  created_at: number;
  updated_at: number;
};

type FakeRateLimit = {
  id: string;
  channel: string;
  actor_external_user_id: string;
  actor_chat_id: string;
  attempt_timestamps_json: string;
  locked_until: number | null;
  created_at: number;
  updated_at: number;
};

const fakeAssistantDb = {
  sessions: new Map<string, FakeSession>(),
  rateLimits: new Map<string, FakeRateLimit>(),
  hasSessionsTable: true,
  hasRateLimitsTable: true,
  failQuery: false,
  reset(): void {
    this.sessions.clear();
    this.rateLimits.clear();
    this.hasSessionsTable = true;
    this.hasRateLimitsTable = true;
    this.failQuery = false;
  },
};

mock.module("../db/assistant-db-proxy.js", () => ({
  assistantDbQuery: mock(async (sql: string, bind?: unknown[]) => {
    if (fakeAssistantDb.failQuery) {
      throw new Error("simulated IPC failure");
    }
    const lower = sql.toLowerCase();
    if (lower.includes("sqlite_master")) {
      const name = bind?.[0];
      if (name === "channel_verification_sessions") {
        return fakeAssistantDb.hasSessionsTable ? [{ "1": 1 }] : [];
      }
      if (name === "channel_guardian_rate_limits") {
        return fakeAssistantDb.hasRateLimitsTable ? [{ "1": 1 }] : [];
      }
      return [];
    }
    if (lower.includes("from channel_verification_sessions")) {
      return Array.from(fakeAssistantDb.sessions.values());
    }
    if (lower.includes("from channel_guardian_rate_limits")) {
      return Array.from(fakeAssistantDb.rateLimits.values());
    }
    return [];
  }),
  // The backfill is copy-only; any assistant write is a bug.
  assistantDbRun: mock(async () => {
    throw new Error("m0013 must not write to the assistant DB");
  }),
  assistantDbExec: mock(async () => {
    throw new Error("m0013 must not write to the assistant DB");
  }),
}));

import {
  initGatewayDb,
  getGatewayDb,
  resetGatewayDb,
} from "../db/connection.js";
import {
  channelVerificationSessions,
  channelGuardianRateLimits,
} from "../db/schema.js";
import { MIGRATIONS } from "../db/data-migrations/index.js";
import {
  up as m0013Up,
  down as m0013Down,
} from "../db/data-migrations/m0013-verification-sessions-backfill.js";

beforeAll(async () => {
  await initGatewayDb();
});

beforeEach(() => {
  const db = getGatewayDb();
  db.delete(channelVerificationSessions).run();
  db.delete(channelGuardianRateLimits).run();
  fakeAssistantDb.reset();
});

afterAll(() => {
  resetGatewayDb();
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function seedAssistantSession(
  opts: Partial<FakeSession> & { id: string },
): void {
  fakeAssistantDb.sessions.set(opts.id, {
    channel: "telegram",
    challenge_hash: "hash-1",
    expires_at: 9_999_999,
    status: "pending",
    source_conversation_id: null,
    consumed_by_external_user_id: null,
    consumed_by_chat_id: null,
    expected_external_user_id: null,
    expected_chat_id: null,
    expected_phone_e164: null,
    identity_binding_status: "bound",
    destination_address: null,
    last_sent_at: null,
    send_count: 0,
    next_resend_at: null,
    code_digits: 6,
    max_attempts: 3,
    verification_purpose: "guardian",
    bootstrap_token_hash: null,
    created_at: 100,
    updated_at: 200,
    ...opts,
  });
}

function seedAssistantRateLimit(
  opts: Partial<FakeRateLimit> & { id: string },
): void {
  fakeAssistantDb.rateLimits.set(opts.id, {
    channel: "telegram",
    actor_external_user_id: "actor-1",
    actor_chat_id: "chat-1",
    attempt_timestamps_json: "[]",
    locked_until: null,
    created_at: 100,
    updated_at: 200,
    ...opts,
  });
}

function seedGatewaySession(
  opts: Partial<typeof channelVerificationSessions.$inferInsert> & {
    id: string;
  },
): void {
  getGatewayDb()
    .insert(channelVerificationSessions)
    .values({
      channel: "telegram",
      challengeHash: "gw-hash",
      expiresAt: 9_999_999,
      status: "pending",
      createdAt: 100,
      updatedAt: 200,
      ...opts,
    })
    .run();
}

function seedGatewayRateLimit(
  opts: Partial<typeof channelGuardianRateLimits.$inferInsert> & {
    id: string;
  },
): void {
  getGatewayDb()
    .insert(channelGuardianRateLimits)
    .values({
      channel: "telegram",
      actorExternalUserId: "actor-1",
      actorChatId: "chat-1",
      attemptTimestampsJson: "[]",
      lockedUntil: null,
      createdAt: 100,
      updatedAt: 200,
      ...opts,
    })
    .run();
}

function gatewaySessionIds(): string[] {
  const rows = getGatewayDb().$client
    .prepare("SELECT id FROM channel_verification_sessions")
    .all() as { id: string }[];
  return rows.map((r) => r.id).sort();
}

function gatewaySession(id: string): Record<string, unknown> | undefined {
  return getGatewayDb().$client
    .prepare("SELECT * FROM channel_verification_sessions WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
}

function gatewayRateLimits(): Record<string, unknown>[] {
  return getGatewayDb().$client
    .prepare("SELECT * FROM channel_guardian_rate_limits ORDER BY id")
    .all() as Record<string, unknown>[];
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("m0013-verification-sessions-backfill", () => {
  test("copies an in-flight session with full field fidelity", async () => {
    seedAssistantSession({
      id: "sess-1",
      channel: "phone",
      challenge_hash: "abc123",
      expires_at: 1_234_567,
      status: "awaiting_response",
      source_conversation_id: "conv-9",
      consumed_by_external_user_id: null,
      consumed_by_chat_id: null,
      expected_external_user_id: "u-7",
      expected_chat_id: "chat-7",
      expected_phone_e164: "+15555550123",
      identity_binding_status: "bound",
      destination_address: "+15555550123",
      last_sent_at: 111,
      send_count: 2,
      next_resend_at: 333,
      code_digits: 4,
      max_attempts: 5,
      verification_purpose: "trusted_contact",
      bootstrap_token_hash: "boot-hash",
      created_at: 42,
      updated_at: 43,
    });

    const result = await m0013Up();

    expect(result).toBe("done");
    const row = gatewaySession("sess-1")!;
    expect(row.channel).toBe("phone");
    expect(row.challenge_hash).toBe("abc123");
    expect(row.expires_at).toBe(1_234_567);
    expect(row.status).toBe("awaiting_response");
    expect(row.source_conversation_id).toBe("conv-9");
    expect(row.consumed_by_external_user_id).toBeNull();
    expect(row.consumed_by_chat_id).toBeNull();
    expect(row.expected_external_user_id).toBe("u-7");
    expect(row.expected_chat_id).toBe("chat-7");
    expect(row.expected_phone_e164).toBe("+15555550123");
    expect(row.identity_binding_status).toBe("bound");
    expect(row.destination_address).toBe("+15555550123");
    expect(row.last_sent_at).toBe(111);
    expect(row.send_count).toBe(2);
    expect(row.next_resend_at).toBe(333);
    expect(row.code_digits).toBe(4);
    expect(row.max_attempts).toBe(5);
    expect(row.verification_purpose).toBe("trusted_contact");
    expect(row.bootstrap_token_hash).toBe("boot-hash");
    expect(row.created_at).toBe(42);
    expect(row.updated_at).toBe(43);
  });

  test("copies every assistant session and rate limit row", async () => {
    seedAssistantSession({ id: "sess-1" });
    seedAssistantSession({ id: "sess-2", channel: "slack" });
    seedAssistantRateLimit({ id: "rl-1" });
    seedAssistantRateLimit({
      id: "rl-2",
      channel: "slack",
      actor_external_user_id: "actor-2",
      actor_chat_id: "chat-2",
      attempt_timestamps_json: "[1,2,3]",
      locked_until: 777,
    });

    const result = await m0013Up();

    expect(result).toBe("done");
    expect(gatewaySessionIds()).toEqual(["sess-1", "sess-2"]);
    const limits = gatewayRateLimits();
    expect(limits.map((r) => r.id)).toEqual(["rl-1", "rl-2"]);
    expect(limits[1]!.attempt_timestamps_json).toBe("[1,2,3]");
    expect(limits[1]!.locked_until).toBe(777);
  });

  test("never overwrites an existing gateway session row", async () => {
    seedGatewaySession({ id: "sess-1", status: "consumed", updatedAt: 900 });
    seedAssistantSession({ id: "sess-1", status: "pending", updated_at: 200 });

    const result = await m0013Up();

    expect(result).toBe("done");
    const row = gatewaySession("sess-1")!;
    expect(row.status).toBe("consumed");
    expect(row.updated_at).toBe(900);
  });

  test("backfills a superseded interceptable session as revoked when the gateway holds a fresh outbound session on the channel", async () => {
    const future = Date.now() + 60_000;
    seedGatewaySession({
      id: "gw-fresh",
      channel: "telegram",
      status: "awaiting_response",
      expiresAt: future,
    });
    seedAssistantSession({
      id: "as-stale",
      channel: "telegram",
      status: "awaiting_response",
      expires_at: future,
    });

    expect(await m0013Up()).toBe("done");

    expect(gatewaySession("as-stale")!.status).toBe("revoked");
    const fresh = gatewaySession("gw-fresh")!;
    expect(fresh.status).toBe("awaiting_response");
    expect(fresh.updated_at).toBe(200);
  });

  test("a fresh inbound gateway session supersedes only assistant pending rows — outbound rows coexist (mirrors createInboundSession's narrower revoke scope)", async () => {
    const future = Date.now() + 60_000;
    seedGatewaySession({
      id: "gw-inbound",
      channel: "telegram",
      status: "pending",
      expiresAt: future,
    });
    seedAssistantSession({
      id: "as-outbound",
      channel: "telegram",
      status: "awaiting_response",
      expires_at: future,
    });
    seedAssistantSession({
      id: "as-inbound",
      channel: "telegram",
      status: "pending",
      expires_at: future,
      challenge_hash: "hash-inbound",
    });

    expect(await m0013Up()).toBe("done");

    expect(gatewaySession("as-outbound")!.status).toBe("awaiting_response");
    expect(gatewaySession("as-inbound")!.status).toBe("revoked");
  });

  test("backfills an interceptable session with its original status when its channel has no gateway session", async () => {
    const future = Date.now() + 60_000;
    seedGatewaySession({
      id: "gw-fresh",
      channel: "telegram",
      status: "pending",
      expiresAt: future,
    });
    seedAssistantSession({
      id: "as-other",
      channel: "slack",
      status: "pending",
      expires_at: future,
    });

    expect(await m0013Up()).toBe("done");
    expect(gatewaySession("as-other")!.status).toBe("pending");
  });

  test("terminal-status and expired assistant rows skip the supersede check", async () => {
    const future = Date.now() + 60_000;
    seedGatewaySession({
      id: "gw-fresh",
      channel: "telegram",
      status: "pending",
      expiresAt: future,
    });
    seedAssistantSession({
      id: "as-consumed",
      channel: "telegram",
      status: "consumed",
      expires_at: future,
    });
    seedAssistantSession({
      id: "as-expired",
      channel: "telegram",
      status: "pending",
      expires_at: Date.now() - 1_000,
      challenge_hash: "hash-expired",
    });

    expect(await m0013Up()).toBe("done");
    expect(gatewaySession("as-consumed")!.status).toBe("consumed");
    expect(gatewaySession("as-expired")!.status).toBe("pending");
  });

  test("gateway sessions with expired or terminal status do not trigger the supersede path", async () => {
    const future = Date.now() + 60_000;
    seedGatewaySession({
      id: "gw-expired",
      channel: "telegram",
      status: "pending",
      expiresAt: Date.now() - 1_000,
    });
    seedGatewaySession({
      id: "gw-consumed",
      channel: "telegram",
      status: "consumed",
      expiresAt: future,
    });
    seedAssistantSession({
      id: "as-live",
      channel: "telegram",
      status: "pending",
      expires_at: future,
    });

    expect(await m0013Up()).toBe("done");
    expect(gatewaySession("as-live")!.status).toBe("pending");
  });

  test("idempotent: re-run after the supersede path yields identical state", async () => {
    const future = Date.now() + 60_000;
    seedGatewaySession({
      id: "gw-fresh",
      channel: "telegram",
      status: "pending",
      expiresAt: future,
    });
    seedAssistantSession({
      id: "as-stale",
      channel: "telegram",
      status: "pending",
      expires_at: future,
    });

    expect(await m0013Up()).toBe("done");
    const firstRun = {
      ids: gatewaySessionIds(),
      stale: gatewaySession("as-stale"),
      fresh: gatewaySession("gw-fresh"),
    };
    expect(firstRun.stale!.status).toBe("revoked");

    expect(await m0013Up()).toBe("done");
    expect(gatewaySessionIds()).toEqual(firstRun.ids);
    expect(gatewaySession("as-stale")).toEqual(firstRun.stale);
    expect(gatewaySession("gw-fresh")).toEqual(firstRun.fresh);
  });

  test("gateway wins a rate-limit conflict on the actor key", async () => {
    seedGatewayRateLimit({ id: "gw-rl", lockedUntil: 555 });
    // Same (channel, actor, chat) key, different id — assistant row must lose.
    seedAssistantRateLimit({ id: "as-rl", locked_until: 111 });

    const result = await m0013Up();

    expect(result).toBe("done");
    const limits = gatewayRateLimits();
    expect(limits).toHaveLength(1);
    expect(limits[0]!.id).toBe("gw-rl");
    expect(limits[0]!.locked_until).toBe(555);
  });

  test("gateway wins a rate-limit conflict on id", async () => {
    seedGatewayRateLimit({ id: "rl-1", lockedUntil: 555 });
    seedAssistantRateLimit({
      id: "rl-1",
      actor_external_user_id: "actor-other",
      locked_until: 111,
    });

    const result = await m0013Up();

    expect(result).toBe("done");
    const limits = gatewayRateLimits();
    expect(limits).toHaveLength(1);
    expect(limits[0]!.locked_until).toBe(555);
    expect(limits[0]!.actor_external_user_id).toBe("actor-1");
  });

  test("idempotent: running twice yields the same rows and values", async () => {
    seedAssistantSession({ id: "sess-1" });
    seedAssistantSession({ id: "sess-2", channel: "slack" });
    seedAssistantRateLimit({ id: "rl-1" });

    expect(await m0013Up()).toBe("done");
    const firstRun = {
      ids: gatewaySessionIds(),
      sess1: gatewaySession("sess-1"),
      limits: gatewayRateLimits(),
    };
    expect(await m0013Up()).toBe("done");

    expect(gatewaySessionIds()).toEqual(firstRun.ids);
    expect(gatewaySession("sess-1")).toEqual(firstRun.sess1);
    expect(gatewayRateLimits()).toEqual(firstRun.limits);
  });

  test("returns done when the assistant sessions table is already dropped", async () => {
    fakeAssistantDb.hasSessionsTable = false;
    seedAssistantRateLimit({ id: "rl-1" });

    const result = await m0013Up();

    expect(result).toBe("done");
    expect(gatewaySessionIds()).toEqual([]);
    expect(gatewayRateLimits()).toEqual([]);
  });

  test("copies sessions even when the rate-limits table is absent", async () => {
    fakeAssistantDb.hasRateLimitsTable = false;
    seedAssistantSession({ id: "sess-1" });

    const result = await m0013Up();

    expect(result).toBe("done");
    expect(gatewaySessionIds()).toEqual(["sess-1"]);
    expect(gatewayRateLimits()).toEqual([]);
  });

  test("returns skip on IPC failure, then completes on retry", async () => {
    seedAssistantSession({ id: "sess-1" });
    fakeAssistantDb.failQuery = true;

    expect(await m0013Up()).toBe("skip");
    expect(gatewaySessionIds()).toEqual([]);

    fakeAssistantDb.failQuery = false;
    expect(await m0013Up()).toBe("done");
    expect(gatewaySessionIds()).toEqual(["sess-1"]);
  });

  test("does not drop or alter the assistant tables (copy, not move)", async () => {
    seedAssistantSession({ id: "sess-1" });
    seedAssistantRateLimit({ id: "rl-1" });

    // The mocked assistantDbRun/Exec throw, so any assistant write would
    // surface as a "skip" instead of "done".
    expect(await m0013Up()).toBe("done");
    expect(fakeAssistantDb.sessions.has("sess-1")).toBe(true);
    expect(fakeAssistantDb.rateLimits.has("rl-1")).toBe(true);
  });

  test("is registered after m0012", () => {
    const keys = MIGRATIONS.map((m) => m.key);
    const m0012Index = keys.indexOf("m0012-migrate-slack-channel-permissions");
    const m0013Index = keys.indexOf("m0013-verification-sessions-backfill");

    expect(m0012Index).toBeGreaterThanOrEqual(0);
    expect(m0013Index).toBe(m0012Index + 1);
  });

  test("down is a no-op (returns done)", () => {
    expect(m0013Down()).toBe("done");
  });
});

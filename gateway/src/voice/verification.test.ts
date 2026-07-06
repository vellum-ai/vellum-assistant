import { describe, test, expect, mock, afterEach, beforeEach } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { initGatewayDb, resetGatewayDb } from "../db/connection.js";

// ---------------------------------------------------------------------------
// Assistant DB proxy mock — backed by an in-process bun:sqlite test DB
// ---------------------------------------------------------------------------

let testAssistantDb: Database | null = null;

mock.module("../db/assistant-db-proxy.js", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async assistantDbQuery(sql: string, bind?: any[]) {
    if (!testAssistantDb) throw new Error("test assistant DB not initialized");
    const stmt = testAssistantDb.prepare(sql);
    return bind ? stmt.all(...bind) : stmt.all();
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async assistantDbRun(sql: string, bind?: any[]) {
    if (!testAssistantDb) throw new Error("test assistant DB not initialized");
    const stmt = testAssistantDb.prepare(sql);
    const result = bind ? stmt.run(...bind) : stmt.run();
    return {
      changes: result.changes,
      lastInsertRowid: Number(result.lastInsertRowid),
    };
  },
  async assistantDbExec(sql: string) {
    if (!testAssistantDb) throw new Error("test assistant DB not initialized");
    testAssistantDb.exec(sql);
  },
}));

const { validateVerificationCode } = await import("./verification.js");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PendingSession = Parameters<typeof validateVerificationCode>[0];

// ---------------------------------------------------------------------------
// Fixture setup
// ---------------------------------------------------------------------------

let testRoot: string;

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

async function setupTestDirs(): Promise<void> {
  testRoot = mkdtempSync(join(tmpdir(), "voice-verify-test-"));
  const securityDir = join(testRoot, "protected");
  mkdirSync(securityDir, { recursive: true });

  const dbDir = join(testRoot, "data", "db");
  mkdirSync(dbDir, { recursive: true });

  const db = new Database(join(dbDir, "assistant.db"));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_verification_sessions (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      challenge_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      verification_purpose TEXT NOT NULL DEFAULT 'guardian',
      expected_external_user_id TEXT,
      expected_chat_id TEXT,
      expected_phone_e164 TEXT,
      identity_binding_status TEXT,
      code_digits INTEGER NOT NULL DEFAULT 6,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      consumed_by_external_user_id TEXT,
      consumed_by_chat_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_guardian_rate_limits (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      actor_external_user_id TEXT NOT NULL,
      actor_chat_id TEXT NOT NULL,
      attempt_timestamps_json TEXT NOT NULL,
      locked_until INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (channel, actor_external_user_id, actor_chat_id)
    )
  `);

  testAssistantDb = db;

  process.env.VELLUM_WORKSPACE_DIR = testRoot;
  process.env.GATEWAY_SECURITY_DIR = securityDir;

  await initGatewayDb();
}

function seedPendingSession(id: string, code: string): PendingSession {
  const now = Date.now();
  const expiresAt = now + 5 * 60 * 1000;
  const challengeHash = hashSecret(code);

  testAssistantDb!
    .prepare(
      `INSERT INTO channel_verification_sessions
        (id, channel, challenge_hash, expires_at, status,
         verification_purpose, code_digits, max_attempts, created_at, updated_at)
       VALUES (?, 'phone', ?, ?, 'pending', 'guardian', 6, 3, ?, ?)`,
    )
    .run(id, challengeHash, expiresAt, now, now);

  return {
    id,
    challengeHash,
    expiresAt,
    status: "pending",
    verificationPurpose: "guardian",
    expectedExternalUserId: null,
    expectedChatId: null,
    expectedPhoneE164: null,
    identityBindingStatus: null,
    codeDigits: 6,
    maxAttempts: 3,
  };
}

function sessionStatus(id: string): string | undefined {
  const row = testAssistantDb!
    .prepare(`SELECT status FROM channel_verification_sessions WHERE id = ?`)
    .get(id) as { status: string } | undefined;
  return row?.status;
}

beforeEach(async () => {
  await setupTestDirs();
});

afterEach(() => {
  resetGatewayDb();
  if (testAssistantDb) {
    try {
      testAssistantDb.close();
    } catch {
      /* best effort */
    }
    testAssistantDb = null;
  }
  try {
    rmSync(testRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// ---------------------------------------------------------------------------
// validateVerificationCode — one-time-code consume semantics
// ---------------------------------------------------------------------------

describe("validateVerificationCode consume path", () => {
  const CODE = "123456";
  const FROM = "+15555550100";

  test("concurrent double-consume yields exactly one success", async () => {
    const session = seedPendingSession("sess-race", CODE);

    const [a, b] = await Promise.all([
      validateVerificationCode(session, CODE, FROM, 0),
      validateVerificationCode(session, CODE, FROM, 0),
    ]);

    const successes = [a, b].filter((r) => r.success);
    expect(successes).toHaveLength(1);
    expect(successes[0]!.verificationType).toBe("guardian");

    // The losing consumer must report failure — never a second success.
    const failure = [a, b].find((r) => !r.success);
    expect(failure).toBeDefined();

    expect(sessionStatus("sess-race")).toBe("consumed");
  });

  test("already-consumed session fails DTMF verification", async () => {
    const session = seedPendingSession("sess-consumed", CODE);

    const first = await validateVerificationCode(session, CODE, FROM, 0);
    expect(first.success).toBe(true);

    // Re-entering the correct code against an already-consumed session must
    // fail — the status guard means the consume returns 0 rows changed.
    const second = await validateVerificationCode(session, CODE, FROM, 0);
    expect(second.success).toBe(false);

    expect(sessionStatus("sess-consumed")).toBe("consumed");
  });
});

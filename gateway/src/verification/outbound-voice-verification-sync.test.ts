import { describe, test, expect, mock, afterEach, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { and, eq } from "drizzle-orm";

import { initSigningKey } from "../auth/token-service.js";
import {
  initGatewayDb,
  getGatewayDb,
  resetGatewayDb,
} from "../db/connection.js";
import { contacts, contactChannels } from "../db/schema.js";

const TEST_SIGNING_KEY = Buffer.from("test-signing-key-at-least-32-bytes-long");
initSigningKey(TEST_SIGNING_KEY);

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

// IPC socket existence check should pass; the sync function early-returns
// when the socket file is missing. We don't actually drive ipcCallAssistant
// in these unit tests — we exercise createPhoneGuardianBinding directly.
mock.module("../ipc/socket-path.js", () => ({
  resolveIpcSocketPath: () => ({ path: "/dev/null" }),
}));

const { createPhoneGuardianBinding } =
  await import("./outbound-voice-verification-sync.js");
const { getMostRecentChannelGuardianTimestamp } =
  await import("./binding-helpers.js");

// ---------------------------------------------------------------------------
// Fixture setup
// ---------------------------------------------------------------------------

let testRoot: string;
let securityDir: string;

async function setupTestDirs(): Promise<void> {
  testRoot = mkdtempSync(join(tmpdir(), "outbound-verify-sync-test-"));
  securityDir = join(testRoot, "protected");
  mkdirSync(securityDir, { recursive: true });

  const dbDir = join(testRoot, "data", "db");
  mkdirSync(dbDir, { recursive: true });

  const db = new Database(join(dbDir, "assistant.db"));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      notes TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      role TEXT NOT NULL DEFAULT 'contact',
      principal_id TEXT,
      user_file TEXT,
      contact_type TEXT NOT NULL DEFAULT 'human'
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS contact_channels (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      address TEXT NOT NULL,
      is_primary INTEGER NOT NULL DEFAULT 0,
      external_user_id TEXT,
      external_chat_id TEXT,
      status TEXT NOT NULL DEFAULT 'unverified',
      policy TEXT NOT NULL DEFAULT 'allow',
      verified_at INTEGER,
      verified_via TEXT,
      invite_id TEXT,
      revoked_reason TEXT,
      blocked_reason TEXT,
      last_seen_at INTEGER,
      interaction_count INTEGER NOT NULL DEFAULT 0,
      last_interaction INTEGER,
      updated_at INTEGER,
      created_at INTEGER NOT NULL
    )
  `);

  testAssistantDb = db;

  process.env.VELLUM_WORKSPACE_DIR = testRoot;
  process.env.GATEWAY_SECURITY_DIR = securityDir;

  await initGatewayDb();
}

// Seeds both DBs: the assistant identity mirror and the gateway DB, which is
// the source of truth for guardian role and channel ACL state.
function insertGuardianContact(id: string, principalId: string, now: number) {
  testAssistantDb!
    .prepare(
      `INSERT INTO contacts (id, display_name, role, principal_id, created_at, updated_at)
       VALUES (?, ?, 'guardian', ?, ?, ?)`,
    )
    .run(id, `Guardian ${id}`, principalId, now, now);

  getGatewayDb()
    .insert(contacts)
    .values({
      id,
      displayName: `Guardian ${id}`,
      role: "guardian",
      principalId,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function insertChannel(opts: {
  id: string;
  contactId: string;
  type: string;
  externalUserId: string;
  status: "active" | "revoked" | "unverified";
  createdAt: number;
  updatedAt: number;
}): void {
  testAssistantDb!
    .prepare(
      `INSERT INTO contact_channels
        (id, contact_id, type, address, external_chat_id,
         is_primary, status, policy, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, 'allow', ?, ?)`,
    )
    .run(
      opts.id,
      opts.contactId,
      opts.type,
      opts.externalUserId,
      opts.externalUserId,
      opts.status,
      opts.createdAt,
      opts.updatedAt,
    );

  getGatewayDb()
    .insert(contactChannels)
    .values({
      id: opts.id,
      contactId: opts.contactId,
      type: opts.type,
      address: opts.externalUserId,
      externalChatId: opts.externalUserId,
      isPrimary: true,
      status: opts.status,
      policy: "allow",
      createdAt: opts.createdAt,
      updatedAt: opts.updatedAt,
    })
    .run();
}

function activeBindingFor(phone: string): {
  address: string;
  status: string;
  updatedAt: number | null;
} | null {
  const row = getGatewayDb()
    .select({
      address: contactChannels.address,
      status: contactChannels.status,
      updatedAt: contactChannels.updatedAt,
    })
    .from(contacts)
    .innerJoin(contactChannels, eq(contactChannels.contactId, contacts.id))
    .where(
      and(
        eq(contacts.role, "guardian"),
        eq(contactChannels.type, "phone"),
        eq(contactChannels.address, phone),
      ),
    )
    .limit(1)
    .get();
  return row ?? null;
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
// getMostRecentChannelGuardianTimestamp
// ---------------------------------------------------------------------------

describe("getMostRecentChannelGuardianTimestamp", () => {
  test("returns null when no guardian binding exists", async () => {
    expect(await getMostRecentChannelGuardianTimestamp("phone")).toBeNull();
  });

  test("returns the max updated_at across active bindings", async () => {
    const now = Date.now();
    insertGuardianContact("c1", "principal-1", now - 5_000);
    insertChannel({
      id: "ch1",
      contactId: "c1",
      type: "phone",
      externalUserId: "+15555550100",
      status: "active",
      createdAt: now - 5_000,
      updatedAt: now - 1_000,
    });

    expect(await getMostRecentChannelGuardianTimestamp("phone")).toBe(
      now - 1_000,
    );
  });

  test("includes REVOKED bindings — the security-critical case", async () => {
    /**
     * If a guardian binding for the same channel has been revoked, the
     * recency check still needs to see its timestamp. Otherwise a stale
     * consumed session inside the 24h lookback window would silently
     * reactivate the revoked binding on gateway restart (ATL-514).
     */
    const now = Date.now();
    insertGuardianContact("c1", "principal-1", now - 10_000);
    insertChannel({
      id: "ch1",
      contactId: "c1",
      type: "phone",
      externalUserId: "+15555550100",
      status: "revoked",
      createdAt: now - 10_000,
      updatedAt: now - 2_000,
    });

    expect(await getMostRecentChannelGuardianTimestamp("phone")).toBe(
      now - 2_000,
    );
  });

  test("returns max across mixed active+revoked rows", async () => {
    const now = Date.now();
    insertGuardianContact("c1", "principal-1", now - 10_000);
    insertChannel({
      id: "ch1",
      contactId: "c1",
      type: "phone",
      externalUserId: "+15555550100",
      status: "revoked",
      createdAt: now - 10_000,
      updatedAt: now - 6_000,
    });
    insertChannel({
      id: "ch2",
      contactId: "c1",
      type: "phone",
      externalUserId: "+15555550150",
      status: "active",
      createdAt: now - 5_000,
      updatedAt: now - 500,
    });

    expect(await getMostRecentChannelGuardianTimestamp("phone")).toBe(
      now - 500,
    );
  });

  test("excludes 'unverified' rows from the recency watermark", async () => {
    /**
     * Sibling flows (e.g. contact-prompt) create guardian phone channels
     * with status='unverified' that are not bindings. Including them in
     * the recency watermark would let a newer unverified row falsely
     * mark a legitimate fresh verification session as stale.
     */
    const now = Date.now();
    insertGuardianContact("c1", "principal-1", now - 10_000);
    insertChannel({
      id: "ch1",
      contactId: "c1",
      type: "phone",
      externalUserId: "+15555550150",
      status: "unverified",
      createdAt: now - 10_000,
      updatedAt: now - 100, // newest, but should be ignored
    });
    insertChannel({
      id: "ch2",
      contactId: "c1",
      type: "phone",
      externalUserId: "+15555550100",
      status: "revoked",
      createdAt: now - 10_000,
      updatedAt: now - 5_000,
    });

    expect(await getMostRecentChannelGuardianTimestamp("phone")).toBe(
      now - 5_000,
    );
  });

  test("returns null when only 'unverified' rows exist", async () => {
    const now = Date.now();
    insertGuardianContact("c1", "principal-1", now - 10_000);
    insertChannel({
      id: "ch1",
      contactId: "c1",
      type: "phone",
      externalUserId: "+15555550150",
      status: "unverified",
      createdAt: now - 10_000,
      updatedAt: now - 100,
    });

    expect(await getMostRecentChannelGuardianTimestamp("phone")).toBeNull();
  });

  test("scopes by channel type", async () => {
    const now = Date.now();
    insertGuardianContact("c1", "principal-1", now - 10_000);
    insertChannel({
      id: "ch1",
      contactId: "c1",
      type: "telegram",
      externalUserId: "tg-1",
      status: "active",
      createdAt: now - 10_000,
      updatedAt: now - 100,
    });

    expect(await getMostRecentChannelGuardianTimestamp("phone")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createPhoneGuardianBinding — recency check
// ---------------------------------------------------------------------------

describe("createPhoneGuardianBinding recency check", () => {
  test("skips when session is older than the most recent revoked binding", async () => {
    /**
     * Scenario: guardian bound phone X, then manually revoked. Gateway
     * restarts within 24h. The consumed session is replayed by the
     * lookback window. Without the recency check, getExistingGuardianBinding
     * would return null (revoked) and createGuardianBinding would
     * reactivate X. With it, the stale session is skipped.
     */
    const now = Date.now();
    insertGuardianContact("c1", "principal-1", now - 60_000);
    insertChannel({
      id: "ch1",
      contactId: "c1",
      type: "phone",
      externalUserId: "+15555550100",
      status: "revoked",
      createdAt: now - 60_000,
      updatedAt: now - 5_000, // revoked AFTER the session was consumed
    });

    const beforeRow = activeBindingFor("+15555550100");

    await createPhoneGuardianBinding(
      "+15555550100",
      "+15555550100",
      now - 10_000, // session consumed BEFORE the revoke
    );

    // Status must remain 'revoked' — no reactivation.
    const afterRow = activeBindingFor("+15555550100");
    expect(afterRow?.status).toBe("revoked");
    expect(afterRow?.updatedAt).toBe(beforeRow?.updatedAt);
  });

  test("skips when session is older than an active binding for a different number", async () => {
    /**
     * Scenario: outbound session for X is in the lookback window, but a
     * sibling path (e.g. inbound verification) bound phone Y after. The
     * legacy code would revoke Y and rebind to stale X. The recency
     * check blocks this displacement.
     */
    const now = Date.now();
    insertGuardianContact("c1", "principal-1", now - 60_000);
    insertChannel({
      id: "ch1",
      contactId: "c1",
      type: "phone",
      externalUserId: "+15555550150",
      status: "active",
      createdAt: now - 30_000,
      updatedAt: now - 2_000, // Y bound after X's session
    });

    await createPhoneGuardianBinding(
      "+15555550100",
      "+15555550100",
      now - 10_000,
    );

    // Y is still active; X was not bound.
    expect(activeBindingFor("+15555550150")?.status).toBe("active");
    expect(activeBindingFor("+15555550100")).toBeNull();
  });

  test("proceeds when no prior binding exists", async () => {
    const now = Date.now();
    await createPhoneGuardianBinding("+15555550100", "+15555550100", now);

    const row = activeBindingFor("+15555550100");
    expect(row?.status).toBe("active");
  });

  test("proceeds when session is newer than the most recent binding event", async () => {
    /**
     * Legitimate re-verification: guardian revokes phone X, later
     * completes a fresh outbound verification for the same number. The
     * fresh session's updated_at is greater than the revoke timestamp,
     * so the binding is correctly recreated. The principal id matches
     * what `resolveCanonicalPrincipal` falls back to when no vellum
     * channel exists (the phone number itself), so the existing contact
     * is reused rather than duplicated.
     */
    const now = Date.now();
    insertGuardianContact("c1", "+15555550100", now - 60_000);
    insertChannel({
      id: "ch1",
      contactId: "c1",
      type: "phone",
      externalUserId: "+15555550100",
      status: "revoked",
      createdAt: now - 60_000,
      updatedAt: now - 10_000,
    });

    await createPhoneGuardianBinding(
      "+15555550100",
      "+15555550100",
      now - 1_000, // fresh session after the revoke
    );

    const row = activeBindingFor("+15555550100");
    expect(row?.status).toBe("active");
  });
});

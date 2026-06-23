/**
 * Tests for createGuardianBinding's gateway dual-write.
 *
 * Uses the REAL gateway DB (so idx_contact_channels_type_address_unique is
 * enforced) plus an in-memory assistant DB behind the proxy mock. Proves the
 * dual-write heals a divergent (type,address) gateway row (m0006) by adopting
 * it by its own id instead of inserting and throwing on the unique index.
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
import { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";

import type { SqliteValue } from "../db/assistant-db-proxy.js";

import "./test-preload.js";

let assistantDb: Database | null = null;

function asstDb(): Database {
  if (!assistantDb) throw new Error("assistant test DB not initialized");
  return assistantDb;
}

mock.module("../db/assistant-db-proxy.js", () => ({
  async assistantDbQuery(sql: string, bind: SqliteValue[] = []) {
    return asstDb()
      .prepare(sql)
      .all(...bind);
  },
  async assistantDbRun(sql: string, bind: SqliteValue[] = []) {
    const result = asstDb()
      .prepare(sql)
      .run(...bind);
    return {
      changes: result.changes,
      lastInsertRowid: Number(result.lastInsertRowid),
    };
  },
  async assistantDbExec(sql: string) {
    asstDb().exec(sql);
  },
}));

import { createGuardianBinding } from "../auth/guardian-bootstrap.js";
import {
  initGatewayDb,
  getGatewayDb,
  resetGatewayDb,
} from "../db/connection.js";
import { contacts, contactChannels } from "../db/schema.js";

function seedGwChannel(opts: {
  contactId: string;
  channelId: string;
  type: string;
  address: string;
  principalId: string;
  status?: string;
  policy?: string;
  blockedReason?: string;
}): void {
  const now = Date.now();
  getGatewayDb()
    .insert(contacts)
    .values({
      id: opts.contactId,
      displayName: `name-${opts.contactId}`,
      role: "guardian",
      principalId: opts.principalId,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  getGatewayDb()
    .insert(contactChannels)
    .values({
      id: opts.channelId,
      contactId: opts.contactId,
      type: opts.type,
      address: opts.address,
      isPrimary: true,
      status: opts.status ?? "active",
      policy: opts.policy ?? "allow",
      blockedReason: opts.blockedReason ?? null,
      verifiedAt: now,
      interactionCount: 0,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

beforeAll(async () => {
  await initGatewayDb();
});

beforeEach(() => {
  const db = getGatewayDb();
  db.delete(contactChannels).run();
  db.delete(contacts).run();

  assistantDb = new Database(":memory:");
  assistantDb.exec(`
    CREATE TABLE contacts (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'contact',
      principal_id TEXT,
      notes TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE contact_channels (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      address TEXT NOT NULL,
      external_chat_id TEXT,
      is_primary INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'unverified',
      policy TEXT NOT NULL DEFAULT 'allow',
      verified_at INTEGER,
      verified_via TEXT,
      revoked_reason TEXT,
      blocked_reason TEXT,
      interaction_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER
    );

    CREATE UNIQUE INDEX idx_contact_channels_type_address
      ON contact_channels(type, address);
  `);
});

afterAll(() => {
  resetGatewayDb();
  assistantDb?.close();
  assistantDb = null;
});

describe("createGuardianBinding gateway dual-write", () => {
  test("heals a divergent (type,address) gateway row instead of throwing", async () => {
    // Gateway row under a DIFFERENT id+contact than the binding will produce.
    seedGwChannel({
      contactId: "stale-contact",
      channelId: "stale-channel",
      type: "slack",
      address: "U_OWNER",
      principalId: "stale-principal",
    });

    const result = await createGuardianBinding({
      channel: "slack",
      externalUserId: "U_OWNER",
      deliveryChatId: "D_OWNER",
      guardianPrincipalId: "guardian-principal",
      displayName: "Example User",
      verifiedVia: "challenge",
    });

    const rows = getGatewayDb()
      .select()
      .from(contactChannels)
      .where(eq(contactChannels.type, "slack"))
      .all();

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBe("stale-channel"); // adopted by its own id
    expect(row.address).toBe("U_OWNER");
    expect(row.status).toBe("active");
    expect(row.policy).toBe("allow");
    expect(row.contactId).toBe(result.contactId);
    expect(row.verifiedVia).toBe("challenge");
  });

  test("never reactivates a blocked divergent (type,address) gateway row", async () => {
    seedGwChannel({
      contactId: "blocked-contact",
      channelId: "blocked-channel",
      type: "slack",
      address: "U_OWNER",
      principalId: "blocked-principal",
      status: "blocked",
      policy: "deny",
      blockedReason: "spam",
    });

    await createGuardianBinding({
      channel: "slack",
      externalUserId: "U_OWNER",
      deliveryChatId: "D_OWNER",
      guardianPrincipalId: "guardian-principal",
      displayName: "Example User",
      verifiedVia: "challenge",
    });

    const rows = getGatewayDb()
      .select()
      .from(contactChannels)
      .where(eq(contactChannels.type, "slack"))
      .all();

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    // Blocked row left intact — not reactivated by the guardian binding.
    expect(row.id).toBe("blocked-channel");
    expect(row.status).toBe("blocked");
    expect(row.policy).toBe("deny");
    expect(row.blockedReason).toBe("spam");
  });

  test("inserts a brand-new (type,address) gateway row when none exists", async () => {
    const result = await createGuardianBinding({
      channel: "slack",
      externalUserId: "U_NEW",
      deliveryChatId: "D_NEW",
      guardianPrincipalId: "guardian-principal",
      displayName: "Example User",
      verifiedVia: "challenge",
    });

    const rows = getGatewayDb()
      .select()
      .from(contactChannels)
      .where(eq(contactChannels.type, "slack"))
      .all();

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBe(result.channelId);
    expect(row.address).toBe("U_NEW");
    expect(row.status).toBe("active");
    expect(row.policy).toBe("allow");
    expect(row.contactId).toBe(result.contactId);
  });
});

/**
 * Tests for createGuardianBinding's id resolution (guardian-by-principal,
 * claimable channel by (type,address), existing channel by (contactId,type)).
 *
 * These reads run against the gateway DB; the resolved contactId/channelId
 * are then adopted by the assistant + gateway dual-write. Guardian/channel
 * rows are seeded in the gateway DB; the assistant DB is an in-memory store
 * behind the proxy mock that receives the writes.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { Database } from "bun:sqlite";

import type { SqliteValue } from "../db/assistant-db-proxy.js";

import "./test-preload.js";

let assistantDb: Database | null = null;

function db(): Database {
  if (!assistantDb) throw new Error("test DB not initialized");
  return assistantDb;
}

mock.module("../db/assistant-db-proxy.js", () => ({
  async assistantDbQuery(sql: string, bind: SqliteValue[] = []) {
    return db()
      .prepare(sql)
      .all(...bind);
  },
  async assistantDbRun(sql: string, bind: SqliteValue[] = []) {
    const result = db()
      .prepare(sql)
      .run(...bind);
    return {
      changes: result.changes,
      lastInsertRowid: Number(result.lastInsertRowid),
    };
  },
  async assistantDbExec(sql: string) {
    db().exec(sql);
  },
}));

import { eq } from "drizzle-orm";

import { createGuardianBinding } from "../auth/guardian-bootstrap.js";
import {
  initGatewayDb,
  getGatewayDb,
  resetGatewayDb,
} from "../db/connection.js";
import { contacts, contactChannels } from "../db/schema.js";

function seedGwGuardianContact(): void {
  getGatewayDb()
    .insert(contacts)
    .values({
      id: "guardian-contact",
      displayName: "Example User",
      role: "guardian",
      principalId: "guardian-principal",
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
}

function seedGwSlackChannel(address: string): void {
  getGatewayDb()
    .insert(contacts)
    .values({
      id: "seed-contact",
      displayName: "Example User",
      role: "contact",
      principalId: null,
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  getGatewayDb()
    .insert(contactChannels)
    .values({
      id: "seed-channel",
      contactId: "seed-contact",
      type: "slack",
      address,
      externalChatId: "D123EXAMPLE",
      isPrimary: false,
      status: "unverified",
      policy: "allow",
      interactionCount: 0,
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
}

function seedGwRevokedGuardianSlackChannel(): void {
  getGatewayDb()
    .insert(contactChannels)
    .values({
      id: "guardian-channel",
      contactId: "guardian-contact",
      type: "slack",
      address: "U123EXAMPLE",
      externalChatId: "D123EXAMPLE",
      isPrimary: true,
      status: "revoked",
      policy: "deny",
      interactionCount: 0,
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
}

beforeAll(async () => {
  await initGatewayDb();
});

beforeEach(() => {
  const gw = getGatewayDb();
  gw.delete(contactChannels).run();
  gw.delete(contacts).run();

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

describe("createGuardianBinding id resolution", () => {
  test("claims a preseeded Slack channel for the guardian instead of minting", async () => {
    seedGwGuardianContact();
    seedGwSlackChannel("U123EXAMPLE");

    const result = await createGuardianBinding({
      channel: "slack",
      externalUserId: "U123EXAMPLE",
      deliveryChatId: "D123EXAMPLE",
      guardianPrincipalId: "guardian-principal",
      displayName: "Example User",
      verifiedVia: "challenge",
    });

    expect(result.contactId).toBe("guardian-contact");
    expect(result.channelId).toBe("seed-channel");
  });

  test("reactivates a revoked guardian channel instead of minting a new one", async () => {
    seedGwGuardianContact();
    seedGwRevokedGuardianSlackChannel();

    const result = await createGuardianBinding({
      channel: "slack",
      externalUserId: "U123EXAMPLE",
      deliveryChatId: "D123EXAMPLE",
      guardianPrincipalId: "guardian-principal",
      displayName: "Example User",
      verifiedVia: "challenge",
    });

    expect(result.contactId).toBe("guardian-contact");
    expect(result.channelId).toBe("guardian-channel");
  });

  // LUM-2672: claiming an inbound-seeded channel must not strand the seed
  // contact as a channel-less duplicate of the guardian.
  test("claiming a seeded channel garbage-collects the orphaned seed contact", async () => {
    seedGwGuardianContact();
    seedGwSlackChannel("U123EXAMPLE");

    await createGuardianBinding({
      channel: "slack",
      externalUserId: "U123EXAMPLE",
      deliveryChatId: "D123EXAMPLE",
      guardianPrincipalId: "guardian-principal",
      displayName: "Example User",
      verifiedVia: "challenge",
    });

    const orphan = getGatewayDb()
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.id, "seed-contact"))
      .get();
    expect(orphan).toBeUndefined();
  });

  test("keeps the previous parent contact when it still has other channels", async () => {
    seedGwGuardianContact();
    seedGwSlackChannel("U123EXAMPLE");
    getGatewayDb()
      .insert(contactChannels)
      .values({
        id: "seed-telegram-channel",
        contactId: "seed-contact",
        type: "telegram",
        address: "tg-1001",
        isPrimary: false,
        status: "unverified",
        policy: "allow",
        interactionCount: 0,
        createdAt: 1,
        updatedAt: 1,
      })
      .run();

    await createGuardianBinding({
      channel: "slack",
      externalUserId: "U123EXAMPLE",
      deliveryChatId: "D123EXAMPLE",
      guardianPrincipalId: "guardian-principal",
      displayName: "Example User",
      verifiedVia: "challenge",
    });

    const kept = getGatewayDb()
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.id, "seed-contact"))
      .get();
    expect(kept?.id).toBe("seed-contact");
  });

  test("never garbage-collects a principal-bearing previous parent", async () => {
    seedGwGuardianContact();
    getGatewayDb()
      .insert(contacts)
      .values({
        id: "principal-contact",
        displayName: "Example User",
        role: "contact",
        principalId: "some-other-principal",
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    getGatewayDb()
      .insert(contactChannels)
      .values({
        id: "principal-channel",
        contactId: "principal-contact",
        type: "slack",
        address: "U123EXAMPLE",
        externalChatId: "D123EXAMPLE",
        isPrimary: false,
        status: "unverified",
        policy: "allow",
        interactionCount: 0,
        createdAt: 1,
        updatedAt: 1,
      })
      .run();

    await createGuardianBinding({
      channel: "slack",
      externalUserId: "U123EXAMPLE",
      deliveryChatId: "D123EXAMPLE",
      guardianPrincipalId: "guardian-principal",
      displayName: "Example User",
      verifiedVia: "challenge",
    });

    const kept = getGatewayDb()
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.id, "principal-contact"))
      .get();
    expect(kept?.id).toBe("principal-contact");
  });
});

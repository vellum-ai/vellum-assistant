import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
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

const fakeGatewayTx = {
  insert: () => ({
    values: () => ({
      onConflictDoUpdate: () => ({ run: () => {} }),
    }),
  }),
};

mock.module("../db/connection.js", () => ({
  getGatewayDb: () => ({
    transaction: (fn: (tx: typeof fakeGatewayTx) => void) => fn(fakeGatewayTx),
  }),
}));

mock.module("../db/schema.js", () => ({
  actorRefreshTokenRecords: {},
  actorTokenRecords: {},
  contacts: {},
  contactChannels: {},
}));

const { createGuardianBinding } = await import("../auth/guardian-bootstrap.js");

beforeEach(() => {
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
      external_user_id TEXT,
      external_chat_id TEXT,
      is_primary INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'unverified',
      policy TEXT NOT NULL DEFAULT 'allow',
      verified_at INTEGER,
      verified_via TEXT,
      revoked_reason TEXT,
      blocked_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER
    );

    CREATE UNIQUE INDEX idx_contact_channels_type_address
      ON contact_channels(type, address);
  `);
});

afterEach(() => {
  assistantDb?.close();
  assistantDb = null;
});

function seedGuardianContact(): void {
  db()
    .prepare(
      `INSERT INTO contacts
         (id, display_name, role, principal_id, notes, created_at, updated_at)
       VALUES
         ('guardian-contact', 'Example User', 'guardian', 'guardian-principal', 'guardian', 1, 1)`,
    )
    .run();
}

function seedSlackContactChannel(address: string): void {
  db()
    .prepare(
      `INSERT INTO contacts
         (id, display_name, role, principal_id, notes, created_at, updated_at)
       VALUES
         ('seed-contact', 'Example User', 'contact', NULL, NULL, 1, 1)`,
    )
    .run();
  db()
    .prepare(
      `INSERT INTO contact_channels
         (id, contact_id, type, address, external_user_id, external_chat_id,
          is_primary, status, policy, created_at, updated_at)
       VALUES
         ('seed-channel', 'seed-contact', 'slack', ?, 'U123EXAMPLE',
          'D123EXAMPLE', 0, 'unverified', 'allow', 1, 1)`,
    )
    .run(address);
}

function seedRevokedGuardianSlackChannel(): void {
  db()
    .prepare(
      `INSERT INTO contact_channels
         (id, contact_id, type, address, external_user_id, external_chat_id,
          is_primary, status, policy, created_at, updated_at)
       VALUES
         ('guardian-channel', 'guardian-contact', 'slack', 'U123EXAMPLE',
          'U123EXAMPLE', 'D123EXAMPLE', 1, 'revoked', 'deny', 1, 1)`,
    )
    .run();
}

describe("createGuardianBinding", () => {
  test("claims a preseeded Slack channel for the guardian instead of inserting a duplicate", async () => {
    seedGuardianContact();
    seedSlackContactChannel("U123EXAMPLE");

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

    const rows = db()
      .query<
        {
          id: string;
          contact_id: string;
          address: string;
          external_user_id: string;
          status: string;
          policy: string;
          is_primary: number;
        },
        []
      >("SELECT * FROM contact_channels WHERE type = 'slack'")
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "seed-channel",
      contact_id: "guardian-contact",
      address: "U123EXAMPLE",
      external_user_id: "U123EXAMPLE",
      status: "active",
      policy: "allow",
      is_primary: 1,
    });
  });

  test("repairs an old lowercase Slack address by matching the preserved external user ID", async () => {
    seedGuardianContact();
    seedSlackContactChannel("u123example");

    await createGuardianBinding({
      channel: "slack",
      externalUserId: "U123EXAMPLE",
      deliveryChatId: "D123EXAMPLE",
      guardianPrincipalId: "guardian-principal",
      displayName: "Example User",
      verifiedVia: "challenge",
    });

    const rows = db()
      .query<
        {
          id: string;
          contact_id: string;
          address: string;
          external_user_id: string;
          status: string;
        },
        []
      >(
        `SELECT id, contact_id, address, external_user_id, status
         FROM contact_channels
         WHERE type = 'slack'`,
      )
      .all();
    expect(rows).toEqual([
      {
        id: "seed-channel",
        contact_id: "guardian-contact",
        address: "U123EXAMPLE",
        external_user_id: "U123EXAMPLE",
        status: "active",
      },
    ]);
  });

  test("prefers the cased guardian channel over a lowercase seed duplicate", async () => {
    seedGuardianContact();
    seedRevokedGuardianSlackChannel();
    seedSlackContactChannel("u123example");

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

    const rows = db()
      .query<
        {
          id: string;
          contact_id: string;
          address: string;
          status: string;
        },
        []
      >(
        `SELECT id, contact_id, address, status
         FROM contact_channels
         WHERE type = 'slack'
         ORDER BY id`,
      )
      .all();
    expect(rows).toEqual([
      {
        id: "guardian-channel",
        contact_id: "guardian-contact",
        address: "U123EXAMPLE",
        status: "active",
      },
      {
        id: "seed-channel",
        contact_id: "seed-contact",
        address: "u123example",
        status: "unverified",
      },
    ]);
  });
});

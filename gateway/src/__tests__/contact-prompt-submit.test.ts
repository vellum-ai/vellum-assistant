/**
 * Tests for POST /v1/contacts/prompt/submit.
 *
 * Covers the key contact-first resolution logic:
 * - Guardian prompts always bind to the existing guardian contact.
 * - Guardian prompts conflict (409) when the channel belongs to another contact.
 * - Non-guardian prompts create or reuse contacts via channel lookup.
 * - All writes are dual-written to the gateway DB.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { Database } from "bun:sqlite";

import { initSigningKey } from "../auth/token-service.js";

initSigningKey(Buffer.from("test-signing-key-at-least-32-bytes-long-xx"));

// ---------------------------------------------------------------------------
// Mock assistant DB proxy with a real in-memory SQLite.
// ---------------------------------------------------------------------------

let testAssistantDb: Database | null = null;

mock.module("../db/assistant-db-proxy.js", () => ({
   
  async assistantDbQuery(sql: string, bind?: any[]) {
    if (!testAssistantDb) throw new Error("test assistant DB not initialized");
    const stmt = testAssistantDb.prepare(sql);
    return bind ? stmt.all(...bind) : stmt.all();
  },
   
  async assistantDbRun(sql: string, bind?: any[]) {
    if (!testAssistantDb) throw new Error("test assistant DB not initialized");
    const stmt = testAssistantDb.prepare(sql);
    const result = bind ? stmt.run(...bind) : stmt.run();
    return { changes: result.changes, lastInsertRowid: Number(result.lastInsertRowid) };
  },
}));

// ---------------------------------------------------------------------------
// Mock IPC so resolve_contact_prompt doesn't try to dial a real socket.
// ---------------------------------------------------------------------------

const ipcMock = mock(async () => ({ resolved: true }));

mock.module("../ipc/assistant-client.js", () => ({
  ipcCallAssistant: ipcMock,
}));

// ---------------------------------------------------------------------------
// Imports that depend on the mocks above.
// ---------------------------------------------------------------------------

const { handleContactPromptSubmit } = await import(
  "../http/routes/contact-prompt.js"
);
const { initGatewayDb, getGatewayDb, resetGatewayDb } = await import(
  "../db/connection.js"
);
const { contactChannels: gwContactChannels, contacts: gwContacts } =
  await import("../db/schema.js");
const { eq } = await import("drizzle-orm");

// ---------------------------------------------------------------------------
// Schema helpers
// ---------------------------------------------------------------------------

function initAssistantDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(`
    CREATE TABLE contacts (
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
    CREATE TABLE contact_channels (
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
  db.exec(
    `CREATE UNIQUE INDEX idx_contact_channels_type_address ON contact_channels(type, address)`,
  );
  return db;
}

// ---------------------------------------------------------------------------
// Request factory
// ---------------------------------------------------------------------------

function makeRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost:7830/v1/contacts/prompt/submit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await initGatewayDb();
});

afterAll(() => {
  resetGatewayDb();
});

beforeEach(() => {
  testAssistantDb = initAssistantDb();
  ipcMock.mockClear();

  const gwDb = getGatewayDb();
  gwDb.delete(gwContactChannels).run();
  gwDb.delete(gwContacts).run();
});

afterEach(() => {
  testAssistantDb?.close();
  testAssistantDb = null;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleContactPromptSubmit", () => {
  test("guardian prompt — creates channel bound to existing guardian contact", async () => {
    const now = Date.now();
    // Seed an existing guardian contact in the assistant DB.
    testAssistantDb!.run(
      `INSERT INTO contacts (id, display_name, role, contact_type, created_at, updated_at)
       VALUES ('guardian-1', 'Vargas', 'guardian', 'human', ?, ?)`,
      [now, now],
    );

    const res = await handleContactPromptSubmit(
      makeRequest({ requestId: "req-1", address: "+15551234567", channelType: "phone", role: "guardian" }),
    );

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.accepted).toBe(true);

    // Channel should be created in assistant DB pointing to guardian.
    const channels = testAssistantDb!
      .prepare(`SELECT contact_id FROM contact_channels WHERE type = 'phone' AND address = ?`)
      .all("+15551234567") as { contact_id: string }[];
    expect(channels).toHaveLength(1);
    expect(channels[0].contact_id).toBe("guardian-1");

    // IPC should have been called with the guardian contactId.
    expect(ipcMock).toHaveBeenCalledTimes(1);
     
    const ipcCall = (ipcMock.mock.calls as any[][])[0][1] as { body: Record<string, unknown> };
    expect(ipcCall.body.contactId).toBe("guardian-1");
  });

  test("guardian prompt — reuses channel already bound to guardian", async () => {
    const now = Date.now();
    testAssistantDb!.run(
      `INSERT INTO contacts (id, display_name, role, contact_type, created_at, updated_at)
       VALUES ('guardian-1', 'Vargas', 'guardian', 'human', ?, ?)`,
      [now, now],
    );
    testAssistantDb!.run(
      `INSERT INTO contact_channels (id, contact_id, type, address, is_primary, status, policy, interaction_count, created_at, updated_at)
       VALUES ('chan-1', 'guardian-1', 'phone', '+15551234567', 1, 'active', 'allow', 5, ?, ?)`,
      [now, now],
    );

    const res = await handleContactPromptSubmit(
      makeRequest({ requestId: "req-2", address: "+15551234567", channelType: "phone", role: "guardian" }),
    );

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.accepted).toBe(true);

    // No new channel should have been inserted.
    const channels = testAssistantDb!
      .prepare(`SELECT id FROM contact_channels WHERE type = 'phone'`)
      .all() as { id: string }[];
    expect(channels).toHaveLength(1);
    expect(channels[0].id).toBe("chan-1");
  });

  test("guardian prompt — 409 when channel already belongs to another contact", async () => {
    const now = Date.now();
    // Guardian contact.
    testAssistantDb!.run(
      `INSERT INTO contacts (id, display_name, role, contact_type, created_at, updated_at)
       VALUES ('guardian-1', 'Vargas', 'guardian', 'human', ?, ?)`,
      [now, now],
    );
    // A different (orphaned or stale) contact that owns the channel.
    testAssistantDb!.run(
      `INSERT INTO contacts (id, display_name, role, contact_type, created_at, updated_at)
       VALUES ('other-1', 'Orphan', 'contact', 'human', ?, ?)`,
      [now, now],
    );
    testAssistantDb!.run(
      `INSERT INTO contact_channels (id, contact_id, type, address, is_primary, status, policy, interaction_count, created_at, updated_at)
       VALUES ('chan-other', 'other-1', 'phone', '+15551234567', 1, 'unverified', 'allow', 0, ?, ?)`,
      [now, now],
    );

    const res = await handleContactPromptSubmit(
      makeRequest({ requestId: "req-3", address: "+15551234567", channelType: "phone", role: "guardian" }),
    );

    expect(res.status).toBe(409);
    const body = await res.json() as Record<string, unknown>;
    expect(body.accepted).toBe(false);

    // The stale channel must not have been deleted.
    const channels = testAssistantDb!
      .prepare(`SELECT id FROM contact_channels WHERE type = 'phone'`)
      .all() as { id: string }[];
    expect(channels).toHaveLength(1);
    expect(channels[0].id).toBe("chan-other");

    // IPC should have been called with an error so the CLI doesn't hang.
    expect(ipcMock).toHaveBeenCalledTimes(1);
     
    const ipcCall = (ipcMock.mock.calls as any[][])[0][1] as { body: Record<string, unknown> };
    expect(typeof ipcCall.body.error).toBe("string");
  });

  test("non-guardian prompt — creates new contact and channel (gateway-first)", async () => {
    const res = await handleContactPromptSubmit(
      makeRequest({
        requestId: "req-4",
        address: "alice@example.com",
        channelType: "email",
        role: "trusted-contact",
        displayName: "Alice",
      }),
    );

    expect(res.status).toBe(200);

    // Gateway DB is the source of truth: contact + channel rows must exist
    // (unverified / allow / primary).
    const gwContactRows = getGatewayDb()
      .select()
      .from(gwContacts)
      .where(eq(gwContacts.displayName, "Alice"))
      .all();
    expect(gwContactRows).toHaveLength(1);
    expect(gwContactRows[0].role).toBe("contact");

    const gwChannelRows = getGatewayDb()
      .select()
      .from(gwContactChannels)
      .where(eq(gwContactChannels.address, "alice@example.com"))
      .all();
    expect(gwChannelRows).toHaveLength(1);
    expect(gwChannelRows[0].contactId).toBe(gwContactRows[0].id);
    expect(gwChannelRows[0].status).toBe("unverified");
    expect(gwChannelRows[0].policy).toBe("allow");
    expect(gwChannelRows[0].isPrimary).toBe(true);

    // The channel id handed to resolve_contact_prompt matches the gateway row.

    const ipcCall = (ipcMock.mock.calls as any[][])[0][1] as { body: Record<string, unknown> };
    expect(ipcCall.body.channelId).toBe(gwChannelRows[0].id);
    expect(ipcCall.body.contactId).toBe(gwContactRows[0].id);
  });

  test("non-guardian prompt — accepted even when assistant-DB mirror throws (gateway-first)", async () => {
    // Make the best-effort assistant-DB mirror fail. The gateway-first write
    // must still succeed and the request still be accepted.
    const realDb = testAssistantDb!;
    testAssistantDb = {
      prepare() {
        throw new Error("assistant DB mirror unavailable");
      },
    } as unknown as Database;

    let res: Response;
    try {
      res = await handleContactPromptSubmit(
        makeRequest({
          requestId: "req-mirror",
          address: "bob@example.com",
          channelType: "email",
          role: "trusted-contact",
          displayName: "Bob",
        }),
      );
    } finally {
      testAssistantDb = realDb;
    }

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.accepted).toBe(true);

    // Gateway DB rows are present despite the mirror failure.
    const gwChannelRows = getGatewayDb()
      .select()
      .from(gwContactChannels)
      .where(eq(gwContactChannels.address, "bob@example.com"))
      .all();
    expect(gwChannelRows).toHaveLength(1);

    const gwContactRows = getGatewayDb()
      .select()
      .from(gwContacts)
      .where(eq(gwContacts.id, gwChannelRows[0].contactId))
      .all();
    expect(gwContactRows).toHaveLength(1);
  });

  test("non-guardian prompt — reuses existing gateway contact and preserves name when displayName omitted", async () => {
    const now = Date.now();
    // Seed an existing gateway contact + channel (gateway DB is the source of
    // truth for the reuse-by-channel lookup).
    getGatewayDb()
      .insert(gwContacts)
      .values({ id: "contact-1", displayName: "Alice", role: "contact", createdAt: now, updatedAt: now })
      .run();
    getGatewayDb()
      .insert(gwContactChannels)
      .values({
        id: "chan-alice",
        contactId: "contact-1",
        type: "email",
        address: "alice@example.com",
        isPrimary: true,
        status: "active",
        policy: "allow",
        interactionCount: 3,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const res = await handleContactPromptSubmit(
      makeRequest({ requestId: "req-5", address: "alice@example.com", channelType: "email" }),
    );

    expect(res.status).toBe(200);

    // No duplicate contact row; the existing contact id is reused.
    const gwContactRows = getGatewayDb().select().from(gwContacts).all();
    expect(gwContactRows).toHaveLength(1);
    expect(gwContactRows[0].id).toBe("contact-1");
    // display_name not clobbered when displayName omitted from the body.
    expect(gwContactRows[0].displayName).toBe("Alice");


    const ipcCall = (ipcMock.mock.calls as any[][])[0][1] as { body: Record<string, unknown> };
    expect(ipcCall.body.contactId).toBe("contact-1");
  });

  test("gateway DB receives dual-write for new contact and channel", async () => {
    const now = Date.now();
    testAssistantDb!.run(
      `INSERT INTO contacts (id, display_name, role, contact_type, created_at, updated_at)
       VALUES ('guardian-1', 'Vargas', 'guardian', 'human', ?, ?)`,
      [now, now],
    );

    // Also seed guardian in gateway DB so FK is satisfied.
    getGatewayDb()
      .insert(gwContacts)
      .values({ id: "guardian-1", displayName: "Vargas", role: "guardian", createdAt: now, updatedAt: now })
      .run();

    await handleContactPromptSubmit(
      makeRequest({ requestId: "req-6", address: "+15559876543", channelType: "phone", role: "guardian" }),
    );

    const gwChannels = getGatewayDb()
      .select()
      .from(gwContactChannels)
      .where(eq(gwContactChannels.address, "+15559876543"))
      .all();
    expect(gwChannels).toHaveLength(1);
    expect(gwChannels[0].contactId).toBe("guardian-1");
  });
});

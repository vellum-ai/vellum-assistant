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
  spyOn,
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
    return {
      changes: result.changes,
      lastInsertRowid: Number(result.lastInsertRowid),
    };
  },
}));

// ---------------------------------------------------------------------------
// Mock IPC so resolve_contact_prompt doesn't try to dial a real socket.
// ---------------------------------------------------------------------------

const ipcMock = mock(async () => ({ resolved: true }));

// Spread the actual module so untouched exports (IpcHandlerError,
// IpcTransportError, ipcSuggestTrustRule) stay importable by later-loaded
// files when suites share a bun process.
const actualAssistantClient = await import("../ipc/assistant-client.js");
mock.module("../ipc/assistant-client.js", () => ({
  ...actualAssistantClient,
  ipcCallAssistant: ipcMock,
}));

// ---------------------------------------------------------------------------
// Imports that depend on the mocks above.
// ---------------------------------------------------------------------------

const { handleContactPromptSubmit } =
  await import("../http/routes/contact-prompt.js");
const { initGatewayDb, getGatewayDb, resetGatewayDb } =
  await import("../db/connection.js");
const { contactChannels: gwContactChannels, contacts: gwContacts } =
  await import("../db/schema.js");
const { ContactStore } = await import("../db/contact-store.js");
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
// IPC call inspectors
//
// The handler fires two IPC operations on a successful mutating submit: an
// `emit_event` { kind: "contacts_changed" } cache-invalidation broadcast plus
// the `resolve_contact_prompt` that unblocks the CLI. These helpers pick the
// right call regardless of order.
// ---------------------------------------------------------------------------

function callsFor(
  ipc: typeof ipcMock,
  op: string,
): { body: Record<string, unknown> }[] {
  return (ipc.mock.calls as any[][])
    .filter((c) => c[0] === op)
    .map((c) => c[1] as { body: Record<string, unknown> });
}

function resolveCall(ipc: typeof ipcMock): { body: Record<string, unknown> } {
  const calls = callsFor(ipc, "resolve_contact_prompt");
  expect(calls).toHaveLength(1);
  return calls[0];
}

function expectEmittedContactsChanged(ipc: typeof ipcMock): void {
  const calls = callsFor(ipc, "emit_event");
  expect(calls.length).toBeGreaterThanOrEqual(1);
  expect(calls.some((c) => c.body.kind === "contacts_changed")).toBe(true);
}

function expectNoEmit(ipc: typeof ipcMock): void {
  expect(callsFor(ipc, "emit_event")).toHaveLength(0);
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
  // Seed a guardian contact into BOTH the gateway DB (source of truth) and the
  // assistant DB mirror. The handler resolves the guardian from the gateway DB;
  // the assistant row keeps the FK for the best-effort channel mirror.
  function seedGuardian(id = "guardian-1", name = "Vargas"): void {
    const now = Date.now();
    getGatewayDb()
      .insert(gwContacts)
      .values({
        id,
        displayName: name,
        role: "guardian",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    testAssistantDb!.run(
      `INSERT INTO contacts (id, display_name, role, contact_type, created_at, updated_at)
       VALUES (?, ?, 'guardian', 'human', ?, ?)`,
      [id, name, now, now],
    );
  }

  test("guardian prompt — binds channel to existing gateway guardian, role preserved", async () => {
    seedGuardian();

    const res = await handleContactPromptSubmit(
      makeRequest({
        requestId: "req-1",
        address: "+12125550123",
        channelType: "phone",
        role: "guardian",
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.accepted).toBe(true);

    // Gateway DB is the source of truth: channel row bound to the guardian.
    const gwChannels = getGatewayDb()
      .select()
      .from(gwContactChannels)
      .where(eq(gwContactChannels.address, "+12125550123"))
      .all();
    expect(gwChannels).toHaveLength(1);
    expect(gwChannels[0].contactId).toBe("guardian-1");

    // Guardian role must be preserved on the gateway contact row.
    const gwGuardian = getGatewayDb()
      .select()
      .from(gwContacts)
      .where(eq(gwContacts.id, "guardian-1"))
      .all();
    expect(gwGuardian).toHaveLength(1);
    expect(gwGuardian[0].role).toBe("guardian");

    // IPC should have been called with the guardian contactId + gateway channel id.
    const ipcCall = resolveCall(ipcMock);
    expect(ipcCall.body.contactId).toBe("guardian-1");
    expect(ipcCall.body.channelId).toBe(gwChannels[0].id);

    // A successful guardian bind invalidates the daemon guardian-id cache.
    expectEmittedContactsChanged(ipcMock);
  });

  test("guardian prompt — reuses channel already bound to guardian", async () => {
    const now = Date.now();
    seedGuardian();
    getGatewayDb()
      .insert(gwContactChannels)
      .values({
        id: "chan-1",
        contactId: "guardian-1",
        type: "phone",
        address: "+12125550123",
        isPrimary: true,
        status: "active",
        policy: "allow",
        interactionCount: 5,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const res = await handleContactPromptSubmit(
      makeRequest({
        requestId: "req-2",
        address: "+12125550123",
        channelType: "phone",
        role: "guardian",
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.accepted).toBe(true);

    // No new channel should have been inserted in the gateway DB.
    const gwChannels = getGatewayDb()
      .select()
      .from(gwContactChannels)
      .where(eq(gwContactChannels.type, "phone"))
      .all();
    expect(gwChannels).toHaveLength(1);
    expect(gwChannels[0].id).toBe("chan-1");

    const ipcCall = resolveCall(ipcMock);
    expect(ipcCall.body.channelId).toBe("chan-1");
    expectEmittedContactsChanged(ipcMock);
  });

  test("guardian prompt — 409 when channel already belongs to another contact", async () => {
    const now = Date.now();
    seedGuardian();
    // A different (orphaned or stale) contact that owns the channel in the
    // gateway DB.
    getGatewayDb()
      .insert(gwContacts)
      .values({
        id: "other-1",
        displayName: "Orphan",
        role: "contact",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    getGatewayDb()
      .insert(gwContactChannels)
      .values({
        id: "chan-other",
        contactId: "other-1",
        type: "phone",
        address: "+12125550123",
        isPrimary: true,
        status: "unverified",
        policy: "allow",
        interactionCount: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const res = await handleContactPromptSubmit(
      makeRequest({
        requestId: "req-3",
        address: "+12125550123",
        channelType: "phone",
        role: "guardian",
      }),
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.accepted).toBe(false);

    // The stale gateway channel must not have been deleted or reassigned, and no
    // new channel row created for the guardian.
    const gwChannels = getGatewayDb()
      .select()
      .from(gwContactChannels)
      .where(eq(gwContactChannels.type, "phone"))
      .all();
    expect(gwChannels).toHaveLength(1);
    expect(gwChannels[0].id).toBe("chan-other");
    expect(gwChannels[0].contactId).toBe("other-1");

    // No assistant-DB channel write occurred for that address either.
    const asChannels = testAssistantDb!
      .prepare(`SELECT id FROM contact_channels WHERE address = ?`)
      .all("+12125550123") as { id: string }[];
    expect(asChannels).toHaveLength(0);

    // IPC should have been called with an error so the CLI doesn't hang.
    expect(ipcMock).toHaveBeenCalledTimes(1);

    const ipcCall = resolveCall(ipcMock);
    expect(typeof ipcCall.body.error).toBe("string");

    // A 409 conflict mutated nothing — no cache-invalidation broadcast.
    expectNoEmit(ipcMock);
  });

  test("guardian prompt — accepted even when assistant-DB mirror throws (gateway-first)", async () => {
    seedGuardian();

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
          requestId: "req-mirror-g",
          address: "+12125550124",
          channelType: "phone",
          role: "guardian",
        }),
      );
    } finally {
      testAssistantDb = realDb;
    }

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.accepted).toBe(true);

    // Gateway DB guardian channel row is present despite the mirror failure.
    const gwChannels = getGatewayDb()
      .select()
      .from(gwContactChannels)
      .where(eq(gwContactChannels.address, "+12125550124"))
      .all();
    expect(gwChannels).toHaveLength(1);
    expect(gwChannels[0].contactId).toBe("guardian-1");
  });

  test("guardian prompt — creates guardian gateway-first when none exists (bootstrap sub-case)", async () => {
    // No guardian seeded anywhere — handler must mint one gateway-first.
    const res = await handleContactPromptSubmit(
      makeRequest({
        requestId: "req-boot",
        address: "+12125550125",
        channelType: "phone",
        role: "guardian",
        displayName: "Boot Guardian",
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.accepted).toBe(true);

    // Guardian created in the gateway DB with role=guardian.
    const gwGuardians = getGatewayDb()
      .select()
      .from(gwContacts)
      .where(eq(gwContacts.role, "guardian"))
      .all();
    expect(gwGuardians).toHaveLength(1);
    expect(gwGuardians[0].displayName).toBe("Boot Guardian");

    // Channel bound to the newly minted guardian.
    const gwChannels = getGatewayDb()
      .select()
      .from(gwContactChannels)
      .where(eq(gwContactChannels.address, "+12125550125"))
      .all();
    expect(gwChannels).toHaveLength(1);
    expect(gwChannels[0].contactId).toBe(gwGuardians[0].id);

    const ipcCall = resolveCall(ipcMock);
    expect(ipcCall.body.contactId).toBe(gwGuardians[0].id);
    expectEmittedContactsChanged(ipcMock);
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
    const ipcCall = resolveCall(ipcMock);
    expect(ipcCall.body.channelId).toBe(gwChannelRows[0].id);
    expect(ipcCall.body.contactId).toBe(gwContactRows[0].id);

    // A successful non-guardian upsert invalidates the daemon contact caches.
    expectEmittedContactsChanged(ipcMock);
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
      .values({
        id: "contact-1",
        displayName: "Alice",
        role: "contact",
        createdAt: now,
        updatedAt: now,
      })
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
      makeRequest({
        requestId: "req-5",
        address: "alice@example.com",
        channelType: "email",
      }),
    );

    expect(res.status).toBe(200);

    // No duplicate contact row; the existing contact id is reused.
    const gwContactRows = getGatewayDb().select().from(gwContacts).all();
    expect(gwContactRows).toHaveLength(1);
    expect(gwContactRows[0].id).toBe("contact-1");
    // display_name not clobbered when displayName omitted from the body.
    expect(gwContactRows[0].displayName).toBe("Alice");

    const ipcCall = resolveCall(ipcMock);
    expect(ipcCall.body.contactId).toBe("contact-1");
    expectEmittedContactsChanged(ipcMock);
  });

  test("non-guardian prompt — explicit null displayName is treated as omitted (preserves name, no 500)", async () => {
    const now = Date.now();
    getGatewayDb()
      .insert(gwContacts)
      .values({
        id: "contact-1",
        displayName: "Alice",
        role: "contact",
        createdAt: now,
        updatedAt: now,
      })
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

    // displayName: null must NOT be written through to the NOT NULL column.
    const res = await handleContactPromptSubmit(
      makeRequest({
        requestId: "req-null",
        address: "alice@example.com",
        channelType: "email",
        displayName: null,
      }),
    );

    expect(res.status).toBe(200);

    const gwContactRows = getGatewayDb().select().from(gwContacts).all();
    expect(gwContactRows).toHaveLength(1);
    expect(gwContactRows[0].id).toBe("contact-1");
    expect(gwContactRows[0].displayName).toBe("Alice");
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
      .values({
        id: "guardian-1",
        displayName: "Vargas",
        role: "guardian",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    await handleContactPromptSubmit(
      makeRequest({
        requestId: "req-6",
        address: "+12125550126",
        channelType: "phone",
        role: "guardian",
      }),
    );

    const gwChannels = getGatewayDb()
      .select()
      .from(gwContactChannels)
      .where(eq(gwContactChannels.address, "+12125550126"))
      .all();
    expect(gwChannels).toHaveLength(1);
    expect(gwChannels[0].contactId).toBe("guardian-1");
  });

  test("guardian prompt — reuse path heals the assistant-DB mirror channel", async () => {
    const now = Date.now();
    seedGuardian();
    // Gateway channel already bound to the guardian (the reuse precondition),
    // but the assistant-DB mirror has NO channel row — simulating a mirror that
    // was unavailable when the channel was first bound.
    getGatewayDb()
      .insert(gwContactChannels)
      .values({
        id: "chan-reuse",
        contactId: "guardian-1",
        type: "phone",
        address: "+15551112222",
        isPrimary: true,
        status: "active",
        policy: "allow",
        interactionCount: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    // Precondition: assistant mirror has no channel for this address.
    expect(
      testAssistantDb!
        .prepare(`SELECT id FROM contact_channels WHERE address = ?`)
        .all("+15551112222"),
    ).toHaveLength(0);

    const res = await handleContactPromptSubmit(
      makeRequest({
        requestId: "req-heal",
        address: "+15551112222",
        channelType: "phone",
        role: "guardian",
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.accepted).toBe(true);

    // No new gateway channel — the existing one is reused.
    const gwChannels = getGatewayDb()
      .select()
      .from(gwContactChannels)
      .where(eq(gwContactChannels.address, "+15551112222"))
      .all();
    expect(gwChannels).toHaveLength(1);
    expect(gwChannels[0].id).toBe("chan-reuse");

    // The reuse path called upsertContact, which healed the assistant-DB
    // mirror: a channel row for the address now exists under the guardian.
    const asChannels = testAssistantDb!
      .prepare(`SELECT contact_id FROM contact_channels WHERE address = ?`)
      .all("+15551112222") as { contact_id: string }[];
    expect(asChannels).toHaveLength(1);
    expect(asChannels[0].contact_id).toBe("guardian-1");

    const ipcCall = resolveCall(ipcMock);
    expect(ipcCall.body.channelId).toBe("chan-reuse");
    expectEmittedContactsChanged(ipcMock);
  });

  test("guardian reuse — mirror-heal upsert throwing is non-fatal (still accepted, reuses channel)", async () => {
    const now = Date.now();
    seedGuardian();
    // Gateway channel already bound to the guardian — reuse precondition.
    getGatewayDb()
      .insert(gwContactChannels)
      .values({
        id: "chan-reuse-fail",
        contactId: "guardian-1",
        type: "phone",
        address: "+15558887777",
        isPrimary: true,
        status: "active",
        policy: "allow",
        interactionCount: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    // The reuse-branch mirror-heal upsertContact throws (e.g. transient
    // gateway SQLITE_BUSY). The reuse path must stay success-guaranteed.
    const spy = spyOn(
      ContactStore.prototype,
      "upsertContact",
    ).mockImplementation(async () => {
      throw new Error("SQLITE_BUSY: database is locked");
    });

    let res: Response;
    try {
      res = await handleContactPromptSubmit(
        makeRequest({
          requestId: "req-reuse-fail",
          address: "+15558887777",
          channelType: "phone",
          role: "guardian",
        }),
      );
    } finally {
      spy.mockRestore();
    }

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.accepted).toBe(true);

    // Existing gateway channel reused — no new row, no reassignment.
    const gwChannels = getGatewayDb()
      .select()
      .from(gwContactChannels)
      .where(eq(gwContactChannels.address, "+15558887777"))
      .all();
    expect(gwChannels).toHaveLength(1);
    expect(gwChannels[0].id).toBe("chan-reuse-fail");
    expect(gwChannels[0].contactId).toBe("guardian-1");

    // Daemon resolved with the existing channel id (success, not error).
    const ipcCall = resolveCall(ipcMock);
    expect(ipcCall.body.channelId).toBe("chan-reuse-fail");
    expect(ipcCall.body.error).toBeUndefined();
    expectEmittedContactsChanged(ipcMock);
  });

  test("guardian bootstrap-create — gateway is authoritative; assistant mirror row exists without ACL role", async () => {
    const res = await handleContactPromptSubmit(
      makeRequest({
        requestId: "req-boot-role",
        address: "+15554445555",
        channelType: "phone",
        role: "guardian",
        displayName: "Role Guardian",
      }),
    );

    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).accepted).toBe(true);

    // Gateway DB is the source of truth for the guardian ACL role.
    const gwGuardians = getGatewayDb()
      .select()
      .from(gwContacts)
      .where(eq(gwContacts.role, "guardian"))
      .all();
    expect(gwGuardians).toHaveLength(1);

    // Assistant mirror is an identity mirror only — the row exists but no ACL
    // role is written through, so it falls back to the schema default 'contact'.
    const asContacts = testAssistantDb!
      .prepare(`SELECT role FROM contacts WHERE id = ?`)
      .all(gwGuardians[0].id) as { role: string }[];
    expect(asContacts).toHaveLength(1);
    expect(asContacts[0].role).toBe("contact");
  });

  test("non-guardian prompt — 500 + daemon error when channel can't be resolved (no empty channelId)", async () => {
    // Force resolveChannelId to miss by making getChannelsForContact return [].
    const spy = spyOn(
      ContactStore.prototype,
      "getChannelsForContact",
    ).mockReturnValue([]);

    let res: Response;
    try {
      res = await handleContactPromptSubmit(
        makeRequest({
          requestId: "req-noresolve",
          address: "carol@example.com",
          channelType: "email",
          role: "trusted-contact",
          displayName: "Carol",
        }),
      );
    } finally {
      spy.mockRestore();
    }

    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.accepted).toBe(false);

    // Daemon was notified with an error (not a success resolve with empty id).
    const ipcCall = resolveCall(ipcMock);
    expect(typeof ipcCall.body.error).toBe("string");
    expect(ipcCall.body.channelId).toBeUndefined();

    // The non-guardian upsert already committed (no rollback on this path)
    // before the read-back miss, so the caches are still invalidated — the
    // emit fires before the channel-id guard.
    expectEmittedContactsChanged(ipcMock);
  });

  test("guardian bind — rolls back freshly-created guardian + 500 when channel can't be resolved", async () => {
    // No guardian seeded: the handler mints one gateway-first, then binds the
    // channel. Force the post-bind resolve to miss so the empty-channelId guard
    // fires and the just-created guardian is cleaned up.
    const spy = spyOn(
      ContactStore.prototype,
      "getChannelsForContact",
    ).mockReturnValue([]);

    let res: Response;
    try {
      res = await handleContactPromptSubmit(
        makeRequest({
          requestId: "req-boot-noresolve",
          address: "+15553334444",
          channelType: "phone",
          role: "guardian",
          displayName: "Doomed Guardian",
        }),
      );
    } finally {
      spy.mockRestore();
    }

    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.accepted).toBe(false);

    // The freshly-created guardian was rolled back (compensating delete).
    const gwGuardians = getGatewayDb()
      .select()
      .from(gwContacts)
      .where(eq(gwContacts.role, "guardian"))
      .all();
    expect(gwGuardians).toHaveLength(0);

    // Daemon notified with an error.
    const ipcCall = resolveCall(ipcMock);
    expect(typeof ipcCall.body.error).toBe("string");

    // The rolled-back bind mutated nothing net — no cache-invalidation broadcast.
    expectNoEmit(ipcMock);
  });

  test("guardian bind — existing guardian, read-back miss still emits (committed bind, no rollback)", async () => {
    // An existing guardian is bound to a NEW channel; the post-bind resolve
    // misses. rollbackCreatedContact is a no-op (the guardian wasn't created
    // here), so the committed channel bind persists and the caches MUST be
    // invalidated despite the 500.
    seedGuardian();
    const spy = spyOn(
      ContactStore.prototype,
      "getChannelsForContact",
    ).mockReturnValue([]);

    let res: Response;
    try {
      res = await handleContactPromptSubmit(
        makeRequest({
          requestId: "req-existing-noresolve",
          address: "+12125550188",
          channelType: "phone",
          role: "guardian",
        }),
      );
    } finally {
      spy.mockRestore();
    }

    expect(res.status).toBe(500);

    // The existing guardian was NOT rolled back.
    const gwGuardians = getGatewayDb()
      .select()
      .from(gwContacts)
      .where(eq(gwContacts.role, "guardian"))
      .all();
    expect(gwGuardians).toHaveLength(1);

    // Committed bind on an existing guardian — caches invalidated despite 500.
    expectEmittedContactsChanged(ipcMock);
  });
});

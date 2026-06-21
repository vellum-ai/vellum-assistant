/**
 * Tests for ContactStore.mergeContacts — gateway-native contact merge.
 *
 * Focus: the assistant-DB mirror soft-fail path. When mergeInAssistantDb
 * throws, the gateway transaction (channel move + donor delete) has already
 * committed. The catch block must still attempt to delete the donor from the
 * assistant DB so that search-style queries (which proxy to the daemon) don't
 * resurrect the merged-away contact.
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

// ── Fake assistant DB ──────────────────────────────────────────────────────

type FakeContactRow = {
  id: string;
  display_name: string;
  notes: string | null;
  role: string | null;
  contact_type: string | null;
  principal_id: string | null;
  user_file: string | null;
  created_at: number;
  updated_at: number | null;
};

type FakeChannelRow = {
  id: string;
  contact_id: string;
  type: string;
  address: string;
  is_primary: number;
  external_user_id: string | null;
  external_chat_id: string | null;
  status: string;
  policy: string;
  verified_at: number | null;
  verified_via: string | null;
  invite_id: string | null;
  revoked_reason: string | null;
  blocked_reason: string | null;
  last_seen_at: number | null;
  interaction_count: number;
  last_interaction: number | null;
  created_at: number;
  updated_at: number | null;
};

const fakeAssistantDb = {
  contacts: new Map<string, FakeContactRow>(),
  channels: new Map<string, FakeChannelRow>(),
  runCalls: [] as { sql: string; bind?: unknown[] }[],
  queryCalls: [] as { sql: string; bind?: unknown[] }[],
  // When set, the next N assistantDbRun calls throw this error.
  runThrowQueue: [] as Error[],
  // When set, the next N assistantDbQuery calls throw this error.
  queryThrowQueue: [] as Error[],
  reset(): void {
    this.contacts.clear();
    this.channels.clear();
    this.runCalls = [];
    this.queryCalls = [];
    this.runThrowQueue = [];
    this.queryThrowQueue = [];
  },
};

mock.module("../db/assistant-db-proxy.js", () => ({
  assistantDbRun: mock(async (sql: string, bind?: unknown[]) => {
    fakeAssistantDb.runCalls.push({ sql, bind });
    if (fakeAssistantDb.runThrowQueue.length > 0) {
      throw fakeAssistantDb.runThrowQueue.shift()!;
    }
    const lower = sql.toLowerCase().trim();
    if (lower.startsWith("delete from contacts")) {
      const id = String(bind?.[0] ?? "");
      fakeAssistantDb.contacts.delete(id);
      // Cascade: remove channels still pointing at the deleted contact.
      for (const [chId, ch] of fakeAssistantDb.channels) {
        if (ch.contact_id === id) {
          fakeAssistantDb.channels.delete(chId);
        }
      }
      return { changes: 1, lastInsertRowid: 0 };
    }
    if (lower.startsWith("delete from contact_channels")) {
      for (const [id, ch] of fakeAssistantDb.channels) {
        if (ch.contact_id === String(bind?.[0] ?? "")) {
          fakeAssistantDb.channels.delete(id);
        }
      }
      return { changes: 1, lastInsertRowid: 0 };
    }
    if (lower.startsWith("update contacts")) {
      return { changes: 1, lastInsertRowid: 0 };
    }
    if (lower.startsWith("update contact_channels")) {
      // Parse: UPDATE contact_channels SET contact_id = ?, updated_at = ? WHERE id = ?
      if (bind && bind.length >= 3) {
        const newContactId = String(bind[0]);
        const channelId = String(bind[2]);
        const ch = fakeAssistantDb.channels.get(channelId);
        if (ch) {
          ch.contact_id = newContactId;
        }
      }
      return { changes: 1, lastInsertRowid: 0 };
    }
    if (lower.startsWith("insert into contacts")) {
      return { changes: 1, lastInsertRowid: 0 };
    }
    return { changes: 0, lastInsertRowid: 0 };
  }),
  assistantDbQuery: mock(async (sql: string, bind?: unknown[]) => {
    fakeAssistantDb.queryCalls.push({ sql, bind });
    if (fakeAssistantDb.queryThrowQueue.length > 0) {
      throw fakeAssistantDb.queryThrowQueue.shift()!;
    }
    const lower = sql.toLowerCase();
    if (lower.includes("from contacts") && lower.includes("where id in")) {
      // SELECT id, notes FROM contacts WHERE id IN (?, ?)
      const ids = bind ?? [];
      const rows: { id: string; notes: string | null }[] = [];
      for (const id of ids) {
        const row = fakeAssistantDb.contacts.get(String(id));
        if (row) rows.push({ id: row.id, notes: row.notes });
      }
      return rows;
    }
    if (
      lower.includes("from contact_channels") &&
      lower.includes("where contact_id")
    ) {
      const cid = String(bind?.[0] ?? "");
      const rows: { id: string; type: string; address: string }[] = [];
      for (const ch of fakeAssistantDb.channels.values()) {
        if (ch.contact_id === cid) {
          rows.push({ id: ch.id, type: ch.type, address: ch.address });
        }
      }
      return rows;
    }
    if (
      lower.includes("from contact_channels") &&
      lower.includes("contact_id = ? and type = ? and address")
    ) {
      // Duplicate check — return empty so the move always happens.
      return [];
    }
    if (lower.includes("from contacts") && lower.includes("user_file like")) {
      return [];
    }
    if (lower.includes("from contacts") && lower.includes("principal_id")) {
      return [];
    }
    return [];
  }),
  assistantDbExec: mock(async () => undefined),
}));

// ── Imports ────────────────────────────────────────────────────────────────

import { ContactStore } from "../db/contact-store.js";
import {
  initGatewayDb,
  getGatewayDb,
  resetGatewayDb,
} from "../db/connection.js";
import { contacts, contactChannels } from "../db/schema.js";

// ── Setup ──────────────────────────────────────────────────────────────────

beforeAll(async () => {
  await initGatewayDb();
});

beforeEach(() => {
  const db = getGatewayDb();
  db.delete(contactChannels).run();
  db.delete(contacts).run();
  fakeAssistantDb.reset();
});

afterAll(() => {
  resetGatewayDb();
});

function seedContact(id: string, role: "guardian" | "contact" = "contact") {
  const now = Date.now();
  getGatewayDb()
    .insert(contacts)
    .values({
      id,
      displayName: `name-${id}`,
      role,
      principalId: `prin-${id}`,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function seedChannel(opts: {
  id: string;
  contactId: string;
  type?: string;
  address?: string;
}) {
  const now = Date.now();
  getGatewayDb()
    .insert(contactChannels)
    .values({
      id: opts.id,
      contactId: opts.contactId,
      type: (opts.type ?? "slack") as never,
      address: opts.address ?? `addr-${opts.id}`,
      isPrimary: false,
      status: "active",
      policy: "allow",
      verifiedAt: null,
      verifiedVia: null,
      interactionCount: 0,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function seedAssistantContact(id: string, notes: string | null = null): void {
  fakeAssistantDb.contacts.set(id, {
    id,
    display_name: `name-${id}`,
    notes,
    role: "contact",
    contact_type: "human",
    principal_id: `prin-${id}`,
    user_file: null,
    created_at: 100,
    updated_at: 100,
  });
}

function seedAssistantChannel(opts: {
  id: string;
  contactId: string;
  type?: string;
  address?: string;
}): void {
  fakeAssistantDb.channels.set(opts.id, {
    id: opts.id,
    contact_id: opts.contactId,
    type: opts.type ?? "slack",
    address: opts.address ?? `addr-${opts.id}`,
    is_primary: 0,
    external_user_id: null,
    external_chat_id: null,
    status: "active",
    policy: "allow",
    verified_at: null,
    verified_via: null,
    invite_id: null,
    revoked_reason: null,
    blocked_reason: null,
    last_seen_at: null,
    interaction_count: 0,
    last_interaction: null,
    created_at: 100,
    updated_at: 100,
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("ContactStore.mergeContacts — assistant DB mirror soft-fail", () => {
  test("compensates donor delete when assistant DB mirror throws", async () => {
    // Gateway DB: two contacts, donor has a channel.
    seedContact("ct_keep", "contact");
    seedContact("ct_merge", "contact");
    seedChannel({ id: "ch_1", contactId: "ct_merge" });

    // Assistant DB: both contacts + donor channel exist.
    seedAssistantContact("ct_keep", "keep notes");
    seedAssistantContact("ct_merge", "merge notes");
    seedAssistantChannel({ id: "ch_1", contactId: "ct_merge" });

    // Make the first assistantDbRun throw — this will cause
    // mergeInAssistantDb to throw at the notes-concat UPDATE step.
    fakeAssistantDb.runThrowQueue.push(new Error("assistant DB unavailable"));

    const store = new ContactStore();
    const result = await store.mergeContacts("ct_keep", "ct_merge");

    // Merge succeeded (gateway DB is source of truth).
    expect(result).not.toBeNull();
    expect(result!.id).toBe("ct_keep");

    // The compensation DELETE should have been called for the donor.
    const deleteCalls = fakeAssistantDb.runCalls.filter((c) =>
      c.sql.toLowerCase().trim().startsWith("delete from contacts"),
    );
    const donorDeleteCalls = deleteCalls.filter(
      (c) => String(c.bind?.[0]) === "ct_merge",
    );
    expect(donorDeleteCalls.length).toBeGreaterThanOrEqual(1);

    // The donor should be gone from the assistant DB fake.
    expect(fakeAssistantDb.contacts.has("ct_merge")).toBe(false);

    // The donor channel should have been reparented to the survivor
    // before the delete (not cascade-wiped).
    const reparented = fakeAssistantDb.channels.get("ch_1");
    expect(reparented).toBeDefined();
    expect(reparented!.contact_id).toBe("ct_keep");
  });

  test("merge succeeds and donor is deleted from assistant DB on happy path", async () => {
    seedContact("ct_keep", "contact");
    seedContact("ct_merge", "contact");
    seedChannel({ id: "ch_1", contactId: "ct_merge" });

    seedAssistantContact("ct_keep", "keep notes");
    seedAssistantContact("ct_merge", "merge notes");

    const store = new ContactStore();
    const result = await store.mergeContacts("ct_keep", "ct_merge");

    expect(result).not.toBeNull();
    expect(result!.id).toBe("ct_keep");

    // Donor deleted from assistant DB.
    expect(fakeAssistantDb.contacts.has("ct_merge")).toBe(false);
    // Survivor still present.
    expect(fakeAssistantDb.contacts.has("ct_keep")).toBe(true);
  });

  test("returns survivor and moves channel in gateway DB", async () => {
    seedContact("ct_keep", "contact");
    seedContact("ct_merge", "contact");
    seedChannel({ id: "ch_1", contactId: "ct_merge" });

    const store = new ContactStore();
    const result = await store.mergeContacts("ct_keep", "ct_merge");

    expect(result).not.toBeNull();
    expect(result!.id).toBe("ct_keep");

    // Channel moved to survivor in gateway DB.
    const db = getGatewayDb();
    const movedChannel = db
      .select()
      .from(contactChannels)
      .all()
      .find((c) => c.id === "ch_1");
    expect(movedChannel?.contactId).toBe("ct_keep");

    // Donor deleted from gateway DB.
    const remaining = db.select().from(contacts).all();
    expect(remaining.find((c) => c.id === "ct_merge")).toBeUndefined();
    expect(remaining.find((c) => c.id === "ct_keep")).toBeDefined();
  });

  test("compensation delete failure logs error but merge still succeeds", async () => {
    seedContact("ct_keep", "contact");
    seedContact("ct_merge", "contact");
    seedChannel({ id: "ch_1", contactId: "ct_merge" });

    seedAssistantContact("ct_keep", "keep notes");
    seedAssistantContact("ct_merge", "merge notes");

    // Queue two errors: first kills mergeInAssistantDb, second kills the
    // compensation delete. The merge should still succeed (gateway DB).
    fakeAssistantDb.runThrowQueue.push(new Error("assistant DB unavailable"));
    fakeAssistantDb.runThrowQueue.push(new Error("assistant DB still down"));

    const store = new ContactStore();
    const result = await store.mergeContacts("ct_keep", "ct_merge");

    expect(result).not.toBeNull();
    expect(result!.id).toBe("ct_keep");

    // Donor still in assistant DB (both attempts failed) — but gateway is
    // consistent. The error is logged for reconciliation.
    expect(fakeAssistantDb.contacts.has("ct_merge")).toBe(true);
  });

  test("skips donor delete when compensation reparent fails (preserves channels)", async () => {
    seedContact("ct_keep", "contact");
    seedContact("ct_merge", "contact");
    seedChannel({ id: "ch_1", contactId: "ct_merge" });

    seedAssistantContact("ct_keep", "keep notes");
    seedAssistantContact("ct_merge", "merge notes");
    seedAssistantChannel({ id: "ch_1", contactId: "ct_merge" });

    // First throw kills mergeInAssistantDb (notes concat step).
    // Then make the reparent query throw by queueing an error for the
    // SELECT from contact_channels call.
    fakeAssistantDb.runThrowQueue.push(new Error("assistant DB unavailable"));
    // The reparent uses assistantDbQuery (not run), so we need to make
    // the query throw. We'll use a queryThrowQueue.
    fakeAssistantDb.queryThrowQueue.push(
      new Error("FK violation: survivor row missing"),
    );

    const store = new ContactStore();
    const result = await store.mergeContacts("ct_keep", "ct_merge");

    expect(result).not.toBeNull();
    expect(result!.id).toBe("ct_keep");

    // Donor should still exist in assistant DB — delete was skipped
    // because reparent failed.
    expect(fakeAssistantDb.contacts.has("ct_merge")).toBe(true);

    // Donor channel should still exist (not cascade-wiped).
    const ch = fakeAssistantDb.channels.get("ch_1");
    expect(ch).toBeDefined();
    expect(ch!.contact_id).toBe("ct_merge");

    // No DELETE FROM contacts should have been called for the donor
    // on the compensation path.
    const donorDeleteCalls = fakeAssistantDb.runCalls.filter(
      (c) =>
        c.sql.toLowerCase().trim().startsWith("delete from contacts") &&
        String(c.bind?.[0]) === "ct_merge",
    );
    expect(donorDeleteCalls.length).toBe(0);
  });
});

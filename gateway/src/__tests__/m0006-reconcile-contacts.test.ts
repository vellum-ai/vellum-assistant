/**
 * Tests for m0006-reconcile-contacts-from-assistant.
 *
 * Verifies that contacts + channels existing in the assistant DB but missing
 * from the gateway DB are seeded into the gateway. Uses the same fake
 * assistant DB + real in-memory gateway DB pattern as the other contact tests.
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

type FakeContact = {
  id: string;
  display_name: string;
  role: string;
  principal_id: string | null;
  created_at: number;
  updated_at: number;
};

type FakeChannel = {
  id: string;
  contact_id: string;
  type: string;
  address: string;
  is_primary: number;
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
  contacts: new Map<string, FakeContact>(),
  channels: new Map<string, FakeChannel>(),
  hasContactsTable: true,
  hasChannelsTable: true,
  hasInviteIdColumn: true,
  reset(): void {
    this.contacts.clear();
    this.channels.clear();
    this.hasContactsTable = true;
    this.hasChannelsTable = true;
    this.hasInviteIdColumn = true;
  },
};

mock.module("../db/assistant-db-proxy.js", () => ({
  assistantDbQuery: mock(async (sql: string) => {
    const lower = sql.toLowerCase();
    if (lower.includes("pragma_table_info('contact_channels')")) {
      return fakeAssistantDb.hasInviteIdColumn ? [{ "1": 1 }] : [];
    }
    if (lower.includes("sqlite_master") && lower.includes("'contacts'")) {
      return fakeAssistantDb.hasContactsTable ? [{ "1": 1 }] : [];
    }
    if (lower.includes("sqlite_master") && lower.includes("'contact_channels'")) {
      return fakeAssistantDb.hasChannelsTable ? [{ "1": 1 }] : [];
    }
    if (lower.includes("from contacts") && !lower.includes("contact_channels")) {
      return Array.from(fakeAssistantDb.contacts.values());
    }
    if (lower.includes("from contact_channels")) {
      // Mirror SQLite: referencing the dropped column errors; the NULL alias
      // is not a column reference.
      const columnRefs = lower.replaceAll("null as invite_id", "");
      if (!fakeAssistantDb.hasInviteIdColumn && columnRefs.includes("invite_id")) {
        throw new Error("no such column: invite_id");
      }
      const rows = Array.from(fakeAssistantDb.channels.values());
      return fakeAssistantDb.hasInviteIdColumn
        ? rows
        : rows.map((ch) => ({ ...ch, invite_id: null }));
    }
    return [];
  }),
  assistantDbRun: mock(async () => ({ changes: 1, lastInsertRowid: 0 })),
  assistantDbExec: mock(async () => undefined),
}));

import {
  initGatewayDb,
  getGatewayDb,
  resetGatewayDb,
} from "../db/connection.js";
import { contacts, contactChannels } from "../db/schema.js";
import { up as m0006Up, down as m0006Down } from "../db/data-migrations/m0006-reconcile-contacts-from-assistant.js";

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

// ── Helpers ─────────────────────────────────────────────────────────────────

function seedGatewayContact(opts: {
  id: string;
  role?: string;
  displayName?: string;
}): void {
  const db = getGatewayDb();
  db.insert(contacts)
    .values({
      id: opts.id,
      displayName: opts.displayName ?? `gw-${opts.id}`,
      role: opts.role ?? "contact",
      principalId: null,
      createdAt: 500,
      updatedAt: 500,
    })
    .run();
}

function seedAssistantContact(opts: {
  id: string;
  role?: string;
  principalId?: string | null;
}): void {
  fakeAssistantDb.contacts.set(opts.id, {
    id: opts.id,
    display_name: `asst-${opts.id}`,
    role: opts.role ?? "contact",
    principal_id: opts.principalId ?? null,
    created_at: 100,
    updated_at: 200,
  });
}

function seedAssistantChannel(opts: {
  id: string;
  contactId: string;
  type?: string;
  status?: string;
}): void {
  fakeAssistantDb.channels.set(opts.id, {
    id: opts.id,
    contact_id: opts.contactId,
    type: opts.type ?? "telegram",
    address: `addr-${opts.id}`,
    is_primary: 0,
    external_chat_id: null,
    status: opts.status ?? "active",
    policy: "allow",
    verified_at: null,
    verified_via: null,
    invite_id: null,
    revoked_reason: null,
    blocked_reason: null,
    last_seen_at: null,
    interaction_count: 0,
    last_interaction: null,
    created_at: 150,
    updated_at: null,
  });
}

function gatewayContactIds(): string[] {
  const rows = getGatewayDb().$client
    .prepare("SELECT id FROM contacts")
    .all() as { id: string }[];
  return rows.map((r) => r.id).sort();
}

function gatewayChannelIds(): string[] {
  const rows = getGatewayDb().$client
    .prepare("SELECT id FROM contact_channels")
    .all() as { id: string }[];
  return rows.map((r) => r.id).sort();
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("m0006-reconcile-contacts-from-assistant", () => {
  test("seeds contacts missing from gateway", async () => {
    seedGatewayContact({ id: "existing-gw" });
    seedAssistantContact({ id: "existing-gw" });
    seedAssistantContact({ id: "missing-1", role: "guardian", principalId: "prin-1" });
    seedAssistantContact({ id: "missing-2" });

    const result = await m0006Up();

    expect(result).toBe("done");
    expect(gatewayContactIds()).toEqual(
      ["existing-gw", "missing-1", "missing-2"].sort(),
    );

    // Verify the reconciled contact has the right ACL fields.
    const row = getGatewayDb().$client
    .prepare("SELECT role, principal_id FROM contacts WHERE id = ?")
      .get("missing-1") as { role: string; principal_id: string };
    expect(row.role).toBe("guardian");
    expect(row.principal_id).toBe("prin-1");
  });

  test("seeds channels missing from gateway", async () => {
    seedAssistantContact({ id: "c1" });
    seedAssistantChannel({ id: "ch1", contactId: "c1", type: "telegram" });
    seedAssistantChannel({ id: "ch2", contactId: "c1", type: "email" });

    const result = await m0006Up();

    expect(result).toBe("done");
    expect(gatewayChannelIds()).toEqual(["ch1", "ch2"].sort());

    // Verify channel has correct fields.
    const ch = getGatewayDb().$client
    .prepare("SELECT type, address, status FROM contact_channels WHERE id = ?")
      .get("ch1") as { type: string; address: string; status: string };
    expect(ch.type).toBe("telegram");
    expect(ch.address).toBe("addr-ch1");
    expect(ch.status).toBe("active");
  });

  test("no-op when gateway already has all contacts + channels", async () => {
    seedGatewayContact({ id: "c1" });
    seedAssistantContact({ id: "c1" });
    // No channels in assistant, no channels in gateway.

    const result = await m0006Up();

    expect(result).toBe("done");
    expect(gatewayContactIds()).toEqual(["c1"]);
  });

  test("does not overwrite existing gateway contacts (INSERT OR IGNORE)", async () => {
    // Gateway has a contact with a different display_name than assistant.
    seedGatewayContact({ id: "c1", displayName: "gateway-name" });
    seedAssistantContact({ id: "c1" }); // display_name would be "asst-c1"

    await m0006Up();

    const row = getGatewayDb().$client
    .prepare("SELECT display_name FROM contacts WHERE id = ?")
      .get("c1") as { display_name: string };
    // Gateway's version is preserved, not overwritten.
    expect(row.display_name).toBe("gateway-name");
  });

  test("idempotent: running twice does not duplicate or error", async () => {
    seedAssistantContact({ id: "c1" });
    seedAssistantChannel({ id: "ch1", contactId: "c1" });

    await m0006Up();
    await m0006Up(); // second run should be a no-op

    expect(gatewayContactIds()).toEqual(["c1"]);
    expect(gatewayChannelIds()).toEqual(["ch1"]);
  });

  test("skips orphaned channels (no parent contact in gateway or assistant)", async () => {
    seedAssistantChannel({ id: "orphan-ch", contactId: "no-such-contact" });

    const result = await m0006Up();

    expect(result).toBe("done");
    // Orphan channel was NOT inserted (FK would fail).
    expect(gatewayChannelIds()).toEqual([]);
  });

  test("channels for reconciled contacts are also seeded", async () => {
    // Contact exists only in assistant, not gateway.
    seedAssistantContact({ id: "new-c" });
    seedAssistantChannel({ id: "ch-new", contactId: "new-c" });

    await m0006Up();

    expect(gatewayContactIds()).toEqual(["new-c"]);
    expect(gatewayChannelIds()).toEqual(["ch-new"]);
  });

  test("completes when assistant contact_channels lacks the invite_id column", async () => {
    fakeAssistantDb.hasInviteIdColumn = false;
    seedAssistantContact({ id: "c1" });
    seedAssistantChannel({ id: "ch1", contactId: "c1" });

    const result = await m0006Up();

    expect(result).toBe("done");
    expect(gatewayContactIds()).toEqual(["c1"]);
    expect(gatewayChannelIds()).toEqual(["ch1"]);
    const ch = getGatewayDb().$client
      .prepare("SELECT invite_id FROM contact_channels WHERE id = ?")
      .get("ch1") as { invite_id: string | null };
    expect(ch.invite_id).toBeNull();
  });

  test("returns done when assistant DB has no contacts table", async () => {
    fakeAssistantDb.hasContactsTable = false;

    const result = await m0006Up();

    expect(result).toBe("done");
    expect(gatewayContactIds()).toEqual([]);
  });

  test("down is a no-op (returns skip)", () => {
    const result = m0006Down();
    expect(result).toBe("skip");
  });

  test("skips channels that conflict by (type, address) COLLATE NOCASE", async () => {
    // Gateway has contact c1 + a channel with address "Addr-1" (mixed case).
    seedGatewayContact({ id: "c1" });
    getGatewayDb().$client
      .prepare(
        `INSERT INTO contact_channels
           (id, contact_id, type, address, is_primary, external_chat_id,
            status, policy, verified_at, verified_via, invite_id,
            revoked_reason, blocked_reason, last_seen_at,
            interaction_count, last_interaction, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "gw-ch",
        "c1",
        "telegram",
        "Addr-1",
        0,
        null,
        "active",
        "allow",
        null,
        null,
        null,
        null,
        null,
        null,
        0,
        null,
        300,
        null,
      );
    // Assistant has a different channel ID but same (type, address) lowercase.
    seedAssistantContact({ id: "c1" });
    seedAssistantChannel({ id: "asst-ch", contactId: "c1", type: "telegram" });
    // Override the address to be lowercase variant.
    fakeAssistantDb.channels.get("asst-ch")!.address = "addr-1";

    await m0006Up();

    // The assistant channel was NOT inserted (case-insensitive conflict).
    const ids = gatewayChannelIds().sort();
    expect(ids).toEqual(["gw-ch"]); // only the original gateway channel
  });

  test("dedupes assistant channels with same (type, address) case-variant", async () => {
    // Assistant DB itself has two rows for the same actor with case variants.
    seedAssistantContact({ id: "c1" });
    seedAssistantChannel({ id: "ch-upper", contactId: "c1", type: "telegram" });
    fakeAssistantDb.channels.get("ch-upper")!.address = "User123";
    seedAssistantChannel({ id: "ch-lower", contactId: "c1", type: "telegram" });
    fakeAssistantDb.channels.get("ch-lower")!.address = "user123";

    await m0006Up();

    // Only one of the two case-variant channels should be inserted.
    const ids = gatewayChannelIds().sort();
    expect(ids.length).toBe(1);
  });

  test("mixed scenario: some contacts in gateway, some missing, with channels", async () => {
    // Contact in both DBs
    seedGatewayContact({ id: "shared" });
    seedAssistantContact({ id: "shared" });
    seedAssistantChannel({ id: "ch-shared", contactId: "shared" });

    // Contact only in assistant
    seedAssistantContact({ id: "only-asst", role: "guardian" });
    seedAssistantChannel({ id: "ch-asst", contactId: "only-asst" });

    // Contact only in gateway (not in assistant) — should remain untouched
    seedGatewayContact({ id: "only-gw" });

    await m0006Up();

    // All three contacts present.
    expect(gatewayContactIds()).toEqual(
      ["only-asst", "only-gw", "shared"].sort(),
    );
    // Channels from both shared and only-asst contacts seeded.
    expect(gatewayChannelIds()).toEqual(["ch-asst", "ch-shared"].sort());
  });
});

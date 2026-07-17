/**
 * Tests for m0008-upsert-acl-columns-from-assistant.
 *
 * Verifies the gateway DB is UPSERTed from the assistant ACL source: missing
 * contacts/channels are inserted with full ACL, existing rows have only their
 * ACL columns updated (display_name + gateway-owned INFO/telemetry untouched),
 * channels are keyed on (type, address) so an id mismatch updates in place
 * without a UNIQUE error, orphan channels are skipped (no FK error), the
 * migration is idempotent, and an unreachable assistant DB yields "skip" with no
 * writes. Uses the same fake-assistant-DB + real in-memory gateway-DB pattern as
 * the m0006/m0007 tests.
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
  created_at: number;
  updated_at: number | null;
};

const fakeAssistantDb = {
  contacts: new Map<string, FakeContact>(),
  channels: new Map<string, FakeChannel>(),
  hasContactsTable: true,
  hasChannelsTable: true,
  hasInviteIdColumn: true,
  hasAclColumns: true,
  reset(): void {
    this.contacts.clear();
    this.channels.clear();
    this.hasContactsTable = true;
    this.hasChannelsTable = true;
    this.hasInviteIdColumn = true;
    this.hasAclColumns = true;
  },
};

mock.module("../db/assistant-db-proxy.js", () => ({
  assistantDbQuery: mock(async (sql: string) => {
    const lower = sql.toLowerCase();
    if (lower.includes("pragma_table_info('contact_channels')")) {
      return fakeAssistantDb.hasInviteIdColumn ? [{ "1": 1 }] : [];
    }
    if (lower.includes("pragma_table_info('contacts')")) {
      return fakeAssistantDb.hasAclColumns
        ? [{ name: "role" }, { name: "principal_id" }]
        : [];
    }
    if (lower.includes("sqlite_master")) {
      if (lower.includes("'contacts'")) {
        return fakeAssistantDb.hasContactsTable ? [{ "1": 1 }] : [];
      }
      if (lower.includes("'contact_channels'")) {
        return fakeAssistantDb.hasChannelsTable ? [{ "1": 1 }] : [];
      }
      return [];
    }
    if (lower.includes("from contact_channels")) {
      // Mirror SQLite: referencing the dropped column errors; the NULL alias
      // is not a column reference.
      const columnRefs = lower.replaceAll("null as invite_id", "");
      if (
        !fakeAssistantDb.hasInviteIdColumn &&
        columnRefs.includes("invite_id")
      ) {
        throw new Error("no such column: invite_id");
      }
      const rows = Array.from(fakeAssistantDb.channels.values());
      return fakeAssistantDb.hasInviteIdColumn
        ? rows
        : rows.map((ch) => ({ ...ch, invite_id: null }));
    }
    if (lower.includes("from contacts")) {
      if (!fakeAssistantDb.hasAclColumns && lower.includes("role")) {
        throw new Error("no such column: role");
      }
      return Array.from(fakeAssistantDb.contacts.values());
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
import {
  up as m0008Up,
  down as m0008Down,
} from "../db/data-migrations/m0008-upsert-acl-columns-from-assistant.js";

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

function seedGatewayContact(opts: { id: string } & Partial<FakeContact>): void {
  getGatewayDb()
    .insert(contacts)
    .values({
      id: opts.id,
      displayName: opts.display_name ?? `gw-${opts.id}`,
      role: opts.role ?? "contact",
      principalId: opts.principal_id ?? null,
      createdAt: opts.created_at ?? 500,
      updatedAt: opts.updated_at ?? 500,
    })
    .run();
}

function seedGatewayChannel(
  opts: {
    id: string;
    contactId: string;
    type: string;
    address: string;
  } & Partial<{
    isPrimary: boolean;
    status: string;
    policy: string;
    verifiedAt: number | null;
    verifiedVia: string | null;
    lastSeenAt: number | null;
    interactionCount: number;
    lastInteraction: number | null;
  }>,
): void {
  getGatewayDb()
    .insert(contactChannels)
    .values({
      id: opts.id,
      contactId: opts.contactId,
      type: opts.type,
      address: opts.address,
      isPrimary: opts.isPrimary ?? false,
      status: opts.status ?? "unverified",
      policy: opts.policy ?? "allow",
      verifiedAt: opts.verifiedAt ?? null,
      verifiedVia: opts.verifiedVia ?? null,
      lastSeenAt: opts.lastSeenAt ?? null,
      interactionCount: opts.interactionCount ?? 0,
      lastInteraction: opts.lastInteraction ?? null,
      createdAt: 500,
      updatedAt: 500,
    })
    .run();
}

function seedAssistantContact(
  opts: { id: string } & Partial<FakeContact>,
): void {
  fakeAssistantDb.contacts.set(opts.id, {
    display_name: `as-${opts.id}`,
    role: "contact",
    principal_id: null,
    created_at: 100,
    updated_at: 200,
    ...opts,
  });
}

function seedAssistantChannel(
  opts: {
    id: string;
    contact_id: string;
    type: string;
    address: string;
  } & Partial<FakeChannel>,
): void {
  fakeAssistantDb.channels.set(opts.id, {
    is_primary: 0,
    external_chat_id: null,
    status: "unverified",
    policy: "allow",
    verified_at: null,
    verified_via: null,
    invite_id: null,
    revoked_reason: null,
    blocked_reason: null,
    created_at: 100,
    updated_at: 200,
    ...opts,
  });
}

function gwContact(id: string): Record<string, unknown> | undefined {
  return getGatewayDb()
    .$client.prepare("SELECT * FROM contacts WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
}

function gwChannelByAddress(
  type: string,
  address: string,
): Record<string, unknown> | undefined {
  return getGatewayDb()
    .$client.prepare(
      "SELECT * FROM contact_channels WHERE type = ? AND address = ?",
    )
    .get(type, address) as Record<string, unknown> | undefined;
}

function gwChannelCount(): number {
  return (
    getGatewayDb()
      .$client.prepare("SELECT count(*) AS n FROM contact_channels")
      .get() as { n: number }
  ).n;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("m0008-upsert-acl-columns-from-assistant", () => {
  test("updates ACL on an existing gateway row; display_name + INFO untouched", async () => {
    seedGatewayContact({
      id: "c1",
      display_name: "gateway-name",
      role: "guardian",
      principal_id: null,
    });
    seedGatewayChannel({
      id: "ch1",
      contactId: "c1",
      type: "telegram",
      address: "addr-1",
      status: "unverified",
      policy: "allow",
      isPrimary: true,
      interactionCount: 9,
      lastSeenAt: 4242,
      lastInteraction: 4243,
    });

    seedAssistantContact({
      id: "c1",
      display_name: "assistant-name",
      role: "contact",
      principal_id: "prin-1",
    });
    seedAssistantChannel({
      id: "ch1",
      contact_id: "c1",
      type: "telegram",
      address: "addr-1",
      status: "verified",
      policy: "deny",
      verified_at: 777,
      verified_via: "invite",
    });

    const result = await m0008Up();
    expect(result).toBe("done");

    const c = gwContact("c1")!;
    expect(c.role).toBe("contact");
    expect(c.principal_id).toBe("prin-1");
    // display_name + timestamps never overwritten.
    expect(c.display_name).toBe("gateway-name");
    expect(c.created_at).toBe(500);

    const ch = gwChannelByAddress("telegram", "addr-1")!;
    expect(ch.status).toBe("verified");
    expect(ch.policy).toBe("deny");
    expect(ch.verified_at).toBe(777);
    expect(ch.verified_via).toBe("invite");
    // INFO/telemetry never overwritten.
    expect(ch.is_primary).toBe(1);
    expect(ch.interaction_count).toBe(9);
    expect(ch.last_seen_at).toBe(4242);
    expect(ch.last_interaction).toBe(4243);
  });

  test("coerces an assistant escalate policy to deny on both upsert paths", async () => {
    // Update path: existing gateway row.
    seedGatewayContact({
      id: "c-esc",
      display_name: "gw",
      role: "contact",
      principal_id: null,
    });
    seedGatewayChannel({
      id: "ch-esc-upd",
      contactId: "c-esc",
      type: "telegram",
      address: "esc-existing",
      policy: "allow",
    });
    seedAssistantContact({ id: "c-esc" });
    seedAssistantChannel({
      id: "ch-esc-upd",
      contact_id: "c-esc",
      type: "telegram",
      address: "esc-existing",
      policy: "escalate",
    });
    // Insert path: channel the gateway lacks.
    seedAssistantChannel({
      id: "ch-esc-ins",
      contact_id: "c-esc",
      type: "telegram",
      address: "esc-new",
      policy: "escalate",
    });

    const result = await m0008Up();
    expect(result).toBe("done");

    expect(gwChannelByAddress("telegram", "esc-existing")!.policy).toBe("deny");
    expect(gwChannelByAddress("telegram", "esc-new")!.policy).toBe("deny");
  });

  test("inserts a contact + channel the gateway lacks with full ACL", async () => {
    seedAssistantContact({
      id: "c2",
      display_name: "new-contact",
      role: "guardian",
      principal_id: "prin-2",
    });
    seedAssistantChannel({
      id: "ch2",
      contact_id: "c2",
      type: "slack",
      address: "addr-2",
      status: "verified",
      policy: "allow",
      verified_at: 999,
      verified_via: "manual",
    });

    const result = await m0008Up();
    expect(result).toBe("done");

    const c = gwContact("c2")!;
    expect(c.display_name).toBe("new-contact");
    expect(c.role).toBe("guardian");
    expect(c.principal_id).toBe("prin-2");

    const ch = gwChannelByAddress("slack", "addr-2")!;
    expect(ch.contact_id).toBe("c2");
    expect(ch.status).toBe("verified");
    expect(ch.verified_at).toBe(999);
    expect(ch.verified_via).toBe("manual");
    // Schema-safe INFO defaults on insert.
    expect(ch.is_primary).toBe(0);
    expect(ch.interaction_count).toBe(0);
    expect(ch.last_seen_at).toBeNull();
    expect(ch.last_interaction).toBeNull();
  });

  test("channel id mismatch updates the existing (type,address) row, no duplicate", async () => {
    seedGatewayContact({ id: "c3" });
    seedGatewayChannel({
      id: "gw-id",
      contactId: "c3",
      type: "telegram",
      address: "shared",
      status: "unverified",
    });

    seedAssistantContact({ id: "c3" });
    seedAssistantChannel({
      id: "assistant-id",
      contact_id: "c3",
      type: "telegram",
      address: "shared",
      status: "verified",
    });

    const result = await m0008Up();
    expect(result).toBe("done");

    expect(gwChannelCount()).toBe(1);
    const ch = gwChannelByAddress("telegram", "shared")!;
    expect(ch.id).toBe("gw-id");
    expect(ch.status).toBe("verified");
  });

  test("case-different address updates the existing row, no duplicate actor", async () => {
    // The gateway UNIQUE(type,address) index is case-sensitive, but the logical
    // key collates NOCASE. An assistant row differing only by address casing must
    // update the existing gateway row, not fork a second channel for the actor.
    seedGatewayContact({ id: "c5" });
    seedGatewayChannel({
      id: "gw-id",
      contactId: "c5",
      type: "telegram",
      address: "U123",
      status: "unverified",
    });

    seedAssistantContact({ id: "c5" });
    seedAssistantChannel({
      id: "assistant-id",
      contact_id: "c5",
      type: "telegram",
      address: "u123",
      status: "verified",
      policy: "deny",
    });

    const result = await m0008Up();
    expect(result).toBe("done");

    expect(gwChannelCount()).toBe(1);
    const ch = gwChannelByAddress("telegram", "U123")!;
    expect(ch.id).toBe("gw-id");
    expect(ch.status).toBe("verified");
    expect(ch.policy).toBe("deny");
    // No second row was inserted under the lowercased address.
    expect(gwChannelByAddress("telegram", "u123") ?? undefined).toBeUndefined();
  });

  test("reparents a split channel onto the assistant contact that carries the role", async () => {
    // Gateway has the channel under a regular contact (a prior split mint); the
    // assistant owns it under the real guardian contact. The backfill must move
    // the channel to the guardian contact so guardian/trust joins through
    // contact_id resolve the imported role, not the stale gateway contact.
    seedGatewayContact({ id: "regular", role: "contact" });
    seedGatewayChannel({
      id: "gw-ch",
      contactId: "regular",
      type: "telegram",
      address: "U999",
      status: "unverified",
    });

    seedAssistantContact({
      id: "guardian",
      role: "guardian",
      principal_id: "p-g",
    });
    seedAssistantChannel({
      id: "as-ch",
      contact_id: "guardian",
      type: "telegram",
      address: "U999",
      status: "verified",
    });

    const result = await m0008Up();
    expect(result).toBe("done");

    // One channel row, now parented to the guardian contact, ACL updated.
    expect(gwChannelCount()).toBe(1);
    const ch = gwChannelByAddress("telegram", "U999")!;
    expect(ch.id).toBe("gw-ch");
    expect(ch.contact_id).toBe("guardian");
    expect(ch.status).toBe("verified");

    // The imported guardian role joins through the reparented channel.
    const guardian = gwContact("guardian")!;
    expect(guardian.role).toBe("guardian");
    expect(guardian.principal_id).toBe("p-g");
  });

  test("orphan channel (contact absent) is skipped without throwing", async () => {
    seedAssistantChannel({
      id: "orphan",
      contact_id: "ghost",
      type: "telegram",
      address: "orphan-addr",
    });

    const result = await m0008Up();
    expect(result).toBe("done");
    expect(gwChannelCount()).toBe(0);
  });

  test("idempotent: two runs yield identical gateway state", async () => {
    seedGatewayContact({ id: "c4", role: "guardian" });
    seedGatewayChannel({
      id: "ch4",
      contactId: "c4",
      type: "telegram",
      address: "addr-4",
    });
    seedAssistantContact({ id: "c4", role: "contact", principal_id: "p4" });
    seedAssistantChannel({
      id: "ch4",
      contact_id: "c4",
      type: "telegram",
      address: "addr-4",
      status: "verified",
    });

    await m0008Up();
    const after1 = {
      contact: gwContact("c4"),
      channel: gwChannelByAddress("telegram", "addr-4"),
      count: gwChannelCount(),
    };

    await m0008Up();
    const after2 = {
      contact: gwContact("c4"),
      channel: gwChannelByAddress("telegram", "addr-4"),
      count: gwChannelCount(),
    };

    expect(after2).toEqual(after1);
  });

  test("completes when assistant contact_channels lacks the invite_id column", async () => {
    fakeAssistantDb.hasInviteIdColumn = false;
    seedAssistantContact({ id: "c6", role: "guardian", principal_id: "p6" });
    seedAssistantChannel({
      id: "ch6",
      contact_id: "c6",
      type: "telegram",
      address: "addr-6",
      status: "verified",
    });

    const result = await m0008Up();
    expect(result).toBe("done");

    const c = gwContact("c6")!;
    expect(c.role).toBe("guardian");
    expect(c.principal_id).toBe("p6");

    const ch = gwChannelByAddress("telegram", "addr-6")!;
    expect(ch.status).toBe("verified");
    expect(ch.invite_id).toBeNull();
  });

  test("returns skip and writes nothing when the assistant DB is unreachable", async () => {
    fakeAssistantDb.hasContactsTable = false;
    seedAssistantContact({ id: "ignored" });

    const result = await m0008Up();
    expect(result).toBe("skip");
    expect(gwContact("ignored") ?? undefined).toBeUndefined();
    expect(gwChannelCount()).toBe(0);
  });

  test("checkpoints instead of throwing when the assistant ACL columns are gone", async () => {
    // Unlike the absent table above, which is transient on a fresh install,
    // assistant persistence migration 305 dropping the columns is terminal.
    fakeAssistantDb.hasAclColumns = false;
    seedAssistantContact({ id: "unreachable" });

    const result = await m0008Up();
    expect(result).toBe("done");
    expect(gwContact("unreachable") ?? undefined).toBeUndefined();
    expect(gwChannelCount()).toBe(0);
  });

  test("down is a no-op (returns skip)", () => {
    expect(m0008Down()).toBe("skip");
  });
});

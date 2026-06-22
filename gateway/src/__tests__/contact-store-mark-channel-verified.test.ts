/**
 * Tests for ContactStore.markChannelVerified — manual channel verification
 * flow used by the /v1/contact-channels/:id/verify endpoint.
 *
 * The assistant DB proxy is mocked behind a per-test fake (`fakeAssistantDb`)
 * so tests can stage either an empty assistant DB (most cases) or a
 * pre-populated one (mirror-from-assistant cases) without spinning up a
 * daemon.
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

type FakeContactRow = {
  id: string;
  display_name: string;
  role: string | null;
  principal_id: string | null;
  created_at: number;
  updated_at: number | null;
};

const fakeAssistantDb = {
  channels: new Map<string, FakeChannelRow>(),
  contacts: new Map<string, FakeContactRow>(),
  runCalls: [] as { sql: string; bind?: unknown[] }[],
  reset(): void {
    this.channels.clear();
    this.contacts.clear();
    this.runCalls = [];
  },
};

// Mock the assistant DB proxy before importing ContactStore. The fake
// honors `SELECT ... FROM contact_channels WHERE id = ?` and
// `SELECT ... FROM contacts WHERE id = ?`; all other SELECTs return [].
// When set, the next id-keyed `UPDATE ... WHERE id = ?` reports 0 changes so
// the logical-key fallback path is exercised. Cleared after one such update.
let nextIdUpdateMisses = false;

mock.module("../db/assistant-db-proxy.js", () => ({
  assistantDbRun: mock(async (sql: string, bind?: unknown[]) => {
    fakeAssistantDb.runCalls.push({ sql, bind });
    if (nextIdUpdateMisses && /where id = \?/i.test(sql)) {
      nextIdUpdateMisses = false;
      return { changes: 0, lastInsertRowid: 0 };
    }
    return { changes: 1, lastInsertRowid: 0 };
  }),
  assistantDbQuery: mock(async (sql: string, bind?: unknown[]) => {
    const lower = sql.toLowerCase();
    if (lower.includes("from contact_channels")) {
      const id = String(bind?.[0] ?? "");
      const row = fakeAssistantDb.channels.get(id);
      return row ? [row] : [];
    }
    if (lower.includes("from contacts")) {
      const id = String(bind?.[0] ?? "");
      const row = fakeAssistantDb.contacts.get(id);
      return row ? [row] : [];
    }
    return [];
  }),
  assistantDbExec: mock(async () => undefined),
}));

import { eq } from "drizzle-orm";

import { ContactStore } from "../db/contact-store.js";
import {
  initGatewayDb,
  getGatewayDb,
  resetGatewayDb,
} from "../db/connection.js";
import { contacts, contactChannels } from "../db/schema.js";

beforeAll(async () => {
  await initGatewayDb();
});

beforeEach(() => {
  const db = getGatewayDb();
  db.delete(contactChannels).run();
  db.delete(contacts).run();
  fakeAssistantDb.reset();
  nextIdUpdateMisses = false;
});

function seedAssistantContact(id: string, role: string = "guardian"): void {
  fakeAssistantDb.contacts.set(id, {
    id,
    display_name: `name-${id}`,
    role,
    principal_id: `prin-${id}`,
    created_at: 100,
    updated_at: 100,
  });
}

function seedAssistantChannel(opts: {
  id: string;
  contactId: string;
  status?: string;
  address?: string;
}): void {
  fakeAssistantDb.channels.set(opts.id, {
    id: opts.id,
    contact_id: opts.contactId,
    type: "vellum",
    address: opts.address ?? `addr-${opts.id}`,
    is_primary: 0,
    external_user_id: null,
    external_chat_id: null,
    status: opts.status ?? "unverified",
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

afterAll(() => {
  resetGatewayDb();
});

function seedContact(id: string, role: "guardian" | "contact" = "guardian") {
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
  status?: string;
  verifiedAt?: number | null;
  verifiedVia?: string | null;
  address?: string;
}) {
  const now = Date.now();
  getGatewayDb()
    .insert(contactChannels)
    .values({
      id: opts.id,
      contactId: opts.contactId,
      type: "vellum",
      address: opts.address ?? `addr-${opts.id}`,
      isPrimary: false,
      status: opts.status ?? "unverified",
      policy: "allow",
      verifiedAt: opts.verifiedAt ?? null,
      verifiedVia: opts.verifiedVia ?? null,
      interactionCount: 0,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

describe("ContactStore.markChannelVerified", () => {
  test("returns null when neither side has the channel", async () => {
    const store = new ContactStore();
    expect(await store.markChannelVerified("missing-id")).toBeNull();
  });

  test("flips an unverified channel to active+verifiedVia=manual", async () => {
    seedContact("c1");
    seedChannel({ id: "ch1", contactId: "c1", status: "unverified" });

    const before = Date.now();
    const result = await new ContactStore().markChannelVerified("ch1");
    expect(result).not.toBeNull();
    expect(result!.didWrite).toBe(true);
    expect(result!.channel.status).toBe("active");
    expect(result!.channel.verifiedVia).toBe("manual");
    expect(result!.channel.verifiedAt).not.toBeNull();
    expect(result!.channel.verifiedAt!).toBeGreaterThanOrEqual(before);
  });

  test("is idempotent on an already-verified channel (no second write)", async () => {
    seedContact("c1");
    seedChannel({
      id: "ch1",
      contactId: "c1",
      status: "active",
      verifiedAt: 1000,
      verifiedVia: "manual",
    });

    const result = await new ContactStore().markChannelVerified("ch1");
    expect(result).not.toBeNull();
    expect(result!.didWrite).toBe(false);
    // verifiedAt must NOT have moved
    expect(result!.channel.verifiedAt).toBe(1000);
    expect(result!.channel.verifiedVia).toBe("manual");
  });

  test("upgrades a previously challenge-verified channel to manual", async () => {
    seedContact("c1");
    seedChannel({
      id: "ch1",
      contactId: "c1",
      status: "active",
      verifiedAt: 500,
      verifiedVia: "challenge",
    });

    const before = Date.now();
    const result = await new ContactStore().markChannelVerified("ch1");
    expect(result).not.toBeNull();
    expect(result!.didWrite).toBe(true);
    expect(result!.channel.verifiedVia).toBe("manual");
    expect(result!.channel.verifiedAt!).toBeGreaterThanOrEqual(before);
  });

  test("re-activates a non-active channel that previously had verifiedAt", async () => {
    seedContact("c1");
    seedChannel({
      id: "ch1",
      contactId: "c1",
      status: "revoked",
      verifiedAt: 500,
      verifiedVia: "challenge",
    });

    const result = await new ContactStore().markChannelVerified("ch1");
    expect(result).not.toBeNull();
    expect(result!.didWrite).toBe(true);
    expect(result!.channel.status).toBe("active");
    expect(result!.channel.verifiedVia).toBe("manual");
  });

  test("two successive calls only write once", async () => {
    seedContact("c1");
    seedChannel({ id: "ch1", contactId: "c1", status: "unverified" });

    const store = new ContactStore();
    const a = await store.markChannelVerified("ch1");
    const b = await store.markChannelVerified("ch1");
    expect(a!.didWrite).toBe(true);
    expect(b!.didWrite).toBe(false);
    // Same verifiedAt — predicate prevented re-stamping
    expect(b!.channel.verifiedAt).toBe(a!.channel.verifiedAt);
  });

  test("writes verifiedVia=challenge to gateway + assistant when passed", async () => {
    seedContact("c1");
    seedChannel({ id: "ch1", contactId: "c1", status: "unverified" });

    const result = await new ContactStore().markChannelVerified(
      "ch1",
      "challenge",
    );
    expect(result).not.toBeNull();
    expect(result!.didWrite).toBe(true);
    expect(result!.channel.status).toBe("active");
    expect(result!.channel.verifiedVia).toBe("challenge");

    // The assistant DB dual-write bound the same verifiedVia.
    const dualWrite = fakeAssistantDb.runCalls.find((c) =>
      c.sql.includes("UPDATE contact_channels"),
    );
    expect(dualWrite).toBeTruthy();
    expect(dualWrite!.bind).toContain("challenge");
    expect(dualWrite!.bind).not.toContain("manual");
  });

  test("is idempotent per-verifiedVia: a repeated challenge call is a no-op", async () => {
    seedContact("c1");
    seedChannel({
      id: "ch1",
      contactId: "c1",
      status: "active",
      verifiedAt: 1000,
      verifiedVia: "challenge",
    });

    const result = await new ContactStore().markChannelVerified(
      "ch1",
      "challenge",
    );
    expect(result).not.toBeNull();
    expect(result!.didWrite).toBe(false);
    expect(result!.channel.verifiedAt).toBe(1000);
    expect(result!.channel.verifiedVia).toBe("challenge");
    // No-op skips the assistant dual-write.
    expect(
      fakeAssistantDb.runCalls.some((c) =>
        c.sql.includes("UPDATE contact_channels"),
      ),
    ).toBe(false);
  });

  test("default (no-arg) call still writes verifiedVia=manual", async () => {
    seedContact("c1");
    seedChannel({ id: "ch1", contactId: "c1", status: "unverified" });

    const result = await new ContactStore().markChannelVerified("ch1");
    expect(result!.didWrite).toBe(true);
    expect(result!.channel.verifiedVia).toBe("manual");

    const dualWrite = fakeAssistantDb.runCalls.find((c) =>
      c.sql.includes("UPDATE contact_channels"),
    );
    expect(dualWrite!.bind).toContain("manual");
  });

  test("mirrors channel + contact from assistant DB when gateway is empty, then verifies", async () => {
    seedAssistantContact("c1");
    seedAssistantChannel({
      id: "ch1",
      contactId: "c1",
      status: "unverified",
    });

    const before = Date.now();
    const result = await new ContactStore().markChannelVerified("ch1");
    expect(result).not.toBeNull();
    expect(result!.didWrite).toBe(true);
    expect(result!.channel.status).toBe("active");
    expect(result!.channel.verifiedVia).toBe("manual");
    expect(result!.channel.verifiedAt!).toBeGreaterThanOrEqual(before);

    // Channel + contact were materialized in the gateway DB.
    const channelInGateway = getGatewayDb()
      .select()
      .from(contactChannels)
      .where(eq(contactChannels.id, "ch1"))
      .get();
    expect(channelInGateway).toBeTruthy();
    expect(channelInGateway!.contactId).toBe("c1");
    expect(channelInGateway!.type).toBe("vellum");
    const contactInGateway = getGatewayDb()
      .select()
      .from(contacts)
      .where(eq(contacts.id, "c1"))
      .get();
    expect(contactInGateway).toBeTruthy();
    expect(contactInGateway!.displayName).toBe("name-c1");
    expect(contactInGateway!.role).toBe("guardian");
  });

  test("verifies the existing gateway row when (type,address) lives under a different id", async () => {
    // Split-brain: the caller's channelId is the assistant id, but the gateway
    // already holds the same (type,address) under a DIFFERENT id (pre-canonical
    // split). Resolve by (type,address) and verify that row instead of 404ing.
    seedContact("c-gw", "contact");
    seedChannel({ id: "gw-ch", contactId: "c-gw", status: "unverified" });
    seedAssistantContact("c-asst", "contact");
    seedAssistantChannel({
      id: "asst-ch",
      contactId: "c-asst",
      status: "unverified",
    });
    fakeAssistantDb.channels.get("asst-ch")!.address = "addr-gw-ch";

    const result = await new ContactStore().markChannelVerified("asst-ch");

    // Existing gateway row was verified; no 404, no duplicate mirror.
    expect(result).not.toBeNull();
    expect(result!.channel.id).toBe("gw-ch");
    expect(result!.channel.status).toBe("active");
    expect(result!.channel.verifiedVia).toBe("manual");
    expect(
      getGatewayDb()
        .select()
        .from(contactChannels)
        .where(eq(contactChannels.id, "asst-ch"))
        .get(),
    ).toBeUndefined();

    // The assistant-side mirror targets the ORIGINAL assistant id, not the
    // resolved gateway id — otherwise the UPDATE no-ops on the split-id path.
    const mirror = fakeAssistantDb.runCalls.find(
      (c) =>
        c.sql.includes("UPDATE contact_channels") &&
        c.sql.includes("WHERE id = ?"),
    );
    expect(mirror).toBeTruthy();
    expect(mirror!.bind?.[mirror!.bind!.length - 1]).toBe("asst-ch");
    expect(mirror!.bind).not.toContain("gw-ch");
  });

  test("refuses to mirror when assistant channel references a missing contact", async () => {
    // Channel present, parent contact absent — broken state, refuse silently.
    seedAssistantChannel({
      id: "ch1",
      contactId: "orphan",
      status: "unverified",
    });

    const result = await new ContactStore().markChannelVerified("ch1");
    expect(result).toBeNull();

    // Nothing landed in the gateway.
    const channelInGateway = getGatewayDb()
      .select()
      .from(contactChannels)
      .where(eq(contactChannels.id, "ch1"))
      .get();
    expect(channelInGateway).toBeUndefined();
  });

  test("mirror is idempotent across successive calls", async () => {
    seedAssistantContact("c1");
    seedAssistantChannel({
      id: "ch1",
      contactId: "c1",
      status: "unverified",
    });

    const store = new ContactStore();
    const first = await store.markChannelVerified("ch1");
    const second = await store.markChannelVerified("ch1");
    expect(first!.didWrite).toBe(true);
    expect(second!.didWrite).toBe(false);
    expect(second!.channel.verifiedAt).toBe(first!.channel.verifiedAt);
    // Mirror INSERT OR IGNORE: still exactly one channel row, one contact row.
    expect(getGatewayDb().select().from(contactChannels).all().length).toBe(1);
    expect(getGatewayDb().select().from(contacts).all().length).toBe(1);
  });

  test("gateway-present channel takes precedence over assistant copy (no mirror, no overwrite)", async () => {
    // Gateway has the row (with a custom display_name for the contact);
    // assistant has a different display_name. We should verify the gateway
    // row in place — not overwrite gateway state with the assistant copy.
    const now = Date.now();
    getGatewayDb()
      .insert(contacts)
      .values({
        id: "c1",
        displayName: "gateway-name",
        role: "guardian",
        principalId: "prin-c1",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    seedChannel({ id: "ch1", contactId: "c1", status: "unverified" });
    seedAssistantContact("c1");
    seedAssistantChannel({
      id: "ch1",
      contactId: "c1",
      status: "unverified",
    });

    const result = await new ContactStore().markChannelVerified("ch1");
    expect(result).not.toBeNull();
    expect(result!.didWrite).toBe(true);
    expect(result!.channel.status).toBe("active");

    const contactRow = getGatewayDb()
      .select()
      .from(contacts)
      .where(eq(contacts.id, "c1"))
      .get();
    expect(contactRow!.displayName).toBe("gateway-name");
  });

  test("legacy channel: resolves a differing gateway id by (contactId,type,address) and verifies", async () => {
    // Migrated user: gateway row lives under a different UUID than the
    // assistant channel id, sharing the logical (contactId, type, address) key.
    seedContact("c1");
    seedChannel({
      id: "gw-uuid",
      contactId: "c1",
      status: "unverified",
      address: "shared-addr",
    });
    seedAssistantContact("c1");
    seedAssistantChannel({
      id: "assistant-uuid",
      contactId: "c1",
      status: "unverified",
      address: "shared-addr",
    });

    const result = await new ContactStore().markChannelVerified(
      "assistant-uuid",
    );
    expect(result).not.toBeNull();
    expect(result!.didWrite).toBe(true);
    expect(result!.channel.id).toBe("gw-uuid");
    expect(result!.channel.status).toBe("active");
    expect(result!.channel.verifiedVia).toBe("manual");

    // Still exactly one gateway channel row — the mirror's ON CONFLICT
    // DO NOTHING did not insert a duplicate.
    expect(
      getGatewayDb().select().from(contactChannels).all().length,
    ).toBe(1);
  });

  test("assistant dual-write falls back to the logical key when the id-keyed update misses", async () => {
    // Legacy mismatch: the caller's id resolves the gateway row, but the
    // id-keyed assistant UPDATE affects 0 rows (the assistant mirror lives
    // under a different UUID). The dual-write must then resolve by logical key.
    seedContact("c1");
    seedChannel({
      id: "gw-uuid",
      contactId: "c1",
      status: "unverified",
      address: "shared-addr",
    });
    nextIdUpdateMisses = true;

    const result = await new ContactStore().markChannelVerified("gw-uuid");
    expect(result!.didWrite).toBe(true);

    const idUpdate = fakeAssistantDb.runCalls.find((c) =>
      /UPDATE contact_channels[\s\S]*WHERE id = \?/i.test(c.sql),
    );
    expect(idUpdate).toBeTruthy();

    const keyUpdate = fakeAssistantDb.runCalls.find((c) =>
      /WHERE type = \? AND address = \? COLLATE NOCASE/i.test(c.sql),
    );
    expect(keyUpdate).toBeTruthy();
    // Logical-key update binds the gateway unique key (type, address) — not
    // contactId, since the assistant row may sit under a different contact.
    expect(keyUpdate!.bind).toContain("vellum");
    expect(keyUpdate!.bind).toContain("shared-addr");
  });

  test("legacy cross-contact: resolves the gateway row by (type,address) even under a different contact", async () => {
    // m0006 can leave the gateway row under a DIFFERENT contact than the
    // assistant mirror. Keying the fallback on (type,address) — the gateway
    // unique key — must still resolve it (no 404), and the write keys on the
    // gateway row's own contact.
    seedContact("gw-contact", "contact");
    seedChannel({
      id: "gw-uuid",
      contactId: "gw-contact",
      status: "unverified",
      address: "shared-addr",
    });
    seedAssistantContact("asst-contact", "contact");
    seedAssistantChannel({
      id: "assistant-uuid",
      contactId: "asst-contact",
      status: "unverified",
      address: "shared-addr",
    });

    const result = await new ContactStore().markChannelVerified(
      "assistant-uuid",
      "challenge",
    );
    expect(result).not.toBeNull();
    expect(result!.channel.id).toBe("gw-uuid");
    expect(result!.channel.contactId).toBe("gw-contact");
    expect(result!.channel.status).toBe("active");
    expect(result!.channel.verifiedVia).toBe("challenge");
  });
});

describe("ContactStore.markChannelRevoked", () => {
  test("revokes a channel by its gateway id", async () => {
    seedContact("c1", "contact");
    seedChannel({ id: "ch1", contactId: "c1", status: "active" });

    const result = await new ContactStore().markChannelRevoked("ch1", "spam");
    expect(result).not.toBeNull();
    expect(result!.didWrite).toBe(true);
    expect(result!.channel.status).toBe("revoked");
    expect(result!.channel.revokedReason).toBe("spam");
  });

  test("legacy channel: resolves a differing gateway id by (contactId,type,address) and revokes", async () => {
    seedContact("c1", "contact");
    seedChannel({
      id: "gw-uuid",
      contactId: "c1",
      status: "active",
      address: "shared-addr",
    });
    seedAssistantContact("c1", "contact");
    seedAssistantChannel({
      id: "assistant-uuid",
      contactId: "c1",
      status: "active",
      address: "shared-addr",
    });

    const result = await new ContactStore().markChannelRevoked(
      "assistant-uuid",
      "spam",
    );
    expect(result).not.toBeNull();
    expect(result!.didWrite).toBe(true);
    expect(result!.channel.id).toBe("gw-uuid");
    expect(result!.channel.status).toBe("revoked");
    expect(result!.channel.revokedReason).toBe("spam");

    // No duplicate gateway row inserted by the mirror.
    expect(
      getGatewayDb().select().from(contactChannels).all().length,
    ).toBe(1);
  });
});

describe("ContactStore.updateChannelStatus (assistant-only backfill)", () => {
  test("backfills a legacy assistant-only channel into the gateway, then revokes", async () => {
    seedAssistantContact("c1", "contact");
    seedAssistantChannel({ id: "ch1", contactId: "c1", status: "active" });

    const updated = await new ContactStore().updateChannelStatus("ch1", {
      status: "revoked",
      reason: "spam",
    });
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("revoked");
    expect(updated!.revokedReason).toBe("spam");

    // Channel + parent contact were materialized in the gateway DB.
    const channelInGateway = getGatewayDb()
      .select()
      .from(contactChannels)
      .where(eq(contactChannels.id, "ch1"))
      .get();
    expect(channelInGateway!.status).toBe("revoked");
    const contactInGateway = getGatewayDb()
      .select()
      .from(contacts)
      .where(eq(contacts.id, "c1"))
      .get();
    expect(contactInGateway).toBeTruthy();
  });

  test("updates the existing gateway row when (type,address) lives under a different contact id", async () => {
    // Split-brain: the assistant resolves the id to a (type,address) that the
    // gateway already holds under a DIFFERENT contact id. `(type,address)` is
    // globally UNIQUE, so we must update that existing ACL row instead of
    // re-mirroring (which would hit the constraint and 404).
    seedContact("c-gw", "contact");
    seedChannel({ id: "gw-ch", contactId: "c-gw", status: "active" });
    // Assistant channel "asst-ch" shares addr (addr-gw-ch) under contact c-asst.
    seedAssistantContact("c-asst", "contact");
    seedAssistantChannel({
      id: "asst-ch",
      contactId: "c-asst",
      status: "active",
    });
    fakeAssistantDb.channels.get("asst-ch")!.address = "addr-gw-ch";

    const updated = await new ContactStore().updateChannelStatus("asst-ch", {
      status: "revoked",
      reason: "spam",
    });

    // Existing gateway row was updated; no 404, no unique-constraint failure.
    expect(updated).not.toBeNull();
    expect(updated!.id).toBe("gw-ch");
    expect(updated!.status).toBe("revoked");

    // No second channel row was mirrored under the assistant id.
    expect(
      getGatewayDb()
        .select()
        .from(contactChannels)
        .where(eq(contactChannels.id, "asst-ch"))
        .get(),
    ).toBeUndefined();
  });

  test("revoke-of-blocked still 409s after backfill", async () => {
    seedAssistantContact("c1", "contact");
    seedAssistantChannel({ id: "ch1", contactId: "c1", status: "blocked" });

    await expect(
      new ContactStore().updateChannelStatus("ch1", { status: "revoked" }),
    ).rejects.toThrow("Cannot revoke a blocked channel");
  });

  test("returns null when neither DB has the channel", async () => {
    const updated = await new ContactStore().updateChannelStatus("missing", {
      status: "revoked",
    });
    expect(updated).toBeNull();
  });

  test("degrades to null when the assistant channel references a missing contact", async () => {
    // Backfill can't complete (orphan channel) → soft-fail to 404, never throw.
    seedAssistantChannel({ id: "ch1", contactId: "orphan", status: "active" });

    const updated = await new ContactStore().updateChannelStatus("ch1", {
      status: "revoked",
    });
    expect(updated).toBeNull();

    const channelInGateway = getGatewayDb()
      .select()
      .from(contactChannels)
      .where(eq(contactChannels.id, "ch1"))
      .get();
    expect(channelInGateway).toBeUndefined();
  });
});

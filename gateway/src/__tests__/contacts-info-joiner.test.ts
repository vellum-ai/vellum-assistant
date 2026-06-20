/**
 * Tests for the gateway-native contact read with assistant info join:
 *   - contacts-info-joiner.fetchInfoForContacts (batch + edge cases)
 *   - ContactStore.listContactsWithInfo / getContactWithInfo (join + soft-fail)
 *
 * The gateway DB is a real (file-backed) DB seeded per test; the assistant DB
 * proxy is mocked behind `fakeAssistantDb` so no daemon is required. Mirrors
 * the pattern in contact-store-mark-channel-verified.test.ts.
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
// Honors the info-join query (SELECT ... FROM contacts LEFT JOIN
// assistant_contact_metadata WHERE c.id IN (...)) and throws on demand.

type FakeInfoRow = {
  id: string;
  notes: string | null;
  user_file: string | null;
  contact_type: string | null;
  species: string | null;
  metadata: string | null;
};

const fakeAssistantDb = {
  info: new Map<string, FakeInfoRow>(),
  throwOnQuery: false as boolean,
  queryCalls: [] as { sql: string; bind?: unknown[] }[],
  reset(): void {
    this.info.clear();
    this.throwOnQuery = false;
    this.queryCalls = [];
  },
};

mock.module("../db/assistant-db-proxy.js", () => ({
  assistantDbQuery: mock(async (sql: string, bind?: unknown[]) => {
    fakeAssistantDb.queryCalls.push({ sql, bind });
    if (fakeAssistantDb.throwOnQuery) {
      throw new Error("simulated assistant DB outage");
    }
    const lower = sql.toLowerCase();
    if (lower.includes("from contacts") && lower.includes("in (")) {
      // Batched info query: bind is the list of contact IDs.
      // Return rows aliased to match the SQL SELECT (camelCase), which is
      // what AssistantInfoRow / contacts-info-joiner reads.
      const ids = (bind ?? []) as string[];
      const out: Array<{
        id: string;
        notes: string | null;
        userFile: string | null;
        contactType: string | null;
        species: string | null;
        metadata: string | null;
      }> = [];
      for (const id of ids) {
        const row = fakeAssistantDb.info.get(id);
        if (row) {
          out.push({
            id: row.id,
            notes: row.notes,
            userFile: row.user_file,
            contactType: row.contact_type,
            species: row.species,
            metadata: row.metadata,
          });
        }
      }
      return out;
    }
    return [];
  }),
  assistantDbRun: mock(async () => ({ changes: 1, lastInsertRowid: 0 })),
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
import { fetchInfoForContacts } from "../db/contacts-info-joiner.js";

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

// ── Gateway seed helpers ────────────────────────────────────────────────────

function seedGatewayContact(opts: {
  id: string;
  role?: string;
  createdAt?: number;
}): void {
  const db = getGatewayDb();
  db.insert(contacts)
    .values({
      id: opts.id,
      displayName: `name-${opts.id}`,
      role: opts.role ?? "contact",
      principalId: null,
      createdAt: opts.createdAt ?? Date.now(),
      updatedAt: opts.createdAt ?? Date.now(),
    })
    .run();
}

function seedGatewayChannel(opts: {
  id: string;
  contactId: string;
  type?: string;
  status?: string;
  interactionCount?: number;
  lastInteraction?: number | null;
  createdAt?: number;
}): void {
  const db = getGatewayDb();
  db.insert(contactChannels)
    .values({
      id: opts.id,
      contactId: opts.contactId,
      type: opts.type ?? "telegram",
      address: `addr-${opts.id}`,
      isPrimary: false,
      externalChatId: null,
      status: opts.status ?? "active",
      policy: "allow",
      verifiedAt: null,
      verifiedVia: null,
      inviteId: null,
      revokedReason: null,
      blockedReason: null,
      lastSeenAt: null,
      interactionCount: opts.interactionCount ?? 0,
      lastInteraction: opts.lastInteraction ?? null,
      createdAt: opts.createdAt ?? 100,
      updatedAt: null,
    })
    .run();
}

function seedAssistantInfo(opts: {
  id: string;
  notes?: string | null;
  userFile?: string | null;
  contactType?: string | null;
  species?: string | null;
  metadata?: Record<string, unknown> | null;
}): void {
  fakeAssistantDb.info.set(opts.id, {
    id: opts.id,
    notes: opts.notes ?? null,
    user_file: opts.userFile ?? null,
    contact_type: opts.contactType ?? null,
    species: opts.species ?? null,
    metadata: opts.metadata != null ? JSON.stringify(opts.metadata) : null,
  });
}

// ── fetchInfoForContacts ────────────────────────────────────────────────────

describe("fetchInfoForContacts", () => {
  test("empty input returns empty map and issues no query", async () => {
    const result = await fetchInfoForContacts([]);
    expect(result.size).toBe(0);
    expect(fakeAssistantDb.queryCalls.length).toBe(0);
  });

  test("batch fetch joins metadata for multiple contacts", async () => {
    seedAssistantInfo({
      id: "c1",
      notes: "friend from college",
      contactType: "human",
    });
    seedAssistantInfo({
      id: "c2",
      contactType: "assistant",
      species: "vellum",
      metadata: { model: "opus" },
    });

    const result = await fetchInfoForContacts(["c1", "c2", "c-missing"]);

    expect(result.size).toBe(2);
    expect(result.has("c-missing")).toBe(false);

    const c1 = result.get("c1")!;
    expect(c1.notes).toBe("friend from college");
    expect(c1.contactType).toBe("human");
    expect(c1.assistantMetadata).toBeNull();

    const c2 = result.get("c2")!;
    expect(c2.contactType).toBe("assistant");
    expect(c2.assistantMetadata).toEqual({
      species: "vellum",
      metadata: { model: "opus" },
    });
  });

  test("malformed metadata JSON degrades to null, does not throw", async () => {
    fakeAssistantDb.info.set("c1", {
      id: "c1",
      notes: null,
      user_file: null,
      contact_type: "assistant",
      species: "vellum",
      metadata: "{not valid json",
    });

    const result = await fetchInfoForContacts(["c1"]);
    const c1 = result.get("c1")!;
    expect(c1.assistantMetadata).toEqual({
      species: "vellum",
      metadata: null,
    });
  });

  test("rethrows when assistantDbQuery throws (caller soft-fails)", async () => {
    fakeAssistantDb.throwOnQuery = true;
    await expect(fetchInfoForContacts(["c1"])).rejects.toThrow(
      "simulated assistant DB outage",
    );
  });

  test("single batched query regardless of id count", async () => {
    seedAssistantInfo({ id: "a" });
    seedAssistantInfo({ id: "b" });
    seedAssistantInfo({ id: "c" });
    await fetchInfoForContacts(["a", "b", "c"]);
    expect(fakeAssistantDb.queryCalls.length).toBe(1);
  });
});

// ── ContactStore.listContactsWithInfo ───────────────────────────────────────

describe("ContactStore.listContactsWithInfo", () => {
  test("joins ACL + info and orders by createdAt desc", async () => {
    seedGatewayContact({ id: "old", createdAt: 100 });
    seedGatewayContact({ id: "new", createdAt: 900 });
    seedGatewayChannel({ id: "ch-new", contactId: "new", interactionCount: 5, lastInteraction: 800 });
    seedGatewayChannel({ id: "ch-old", contactId: "old", interactionCount: 2, lastInteraction: 200 });
    seedAssistantInfo({ id: "new", notes: "new notes", contactType: "human" });
    seedAssistantInfo({ id: "old", notes: "old notes", contactType: "assistant", species: "vellum", metadata: { x: 1 } });

    const result = await new ContactStore().listContactsWithInfo();

    expect(result.map((c) => c.id)).toEqual(["new", "old"]);

    const newest = result[0];
    expect(newest.role).toBe("contact");
    expect(newest.notes).toBe("new notes");
    expect(newest.contactType).toBe("human");
    expect(newest.assistantMetadata).toBeNull();
    // Trust signals derived from gateway channels.
    expect(newest.interactionCount).toBe(5);
    expect(newest.lastInteraction).toBe(800);
    expect(newest.channels).toHaveLength(1);
    expect(newest.channels[0].id).toBe("ch-new");

    const oldest = result[1];
    expect(oldest.assistantMetadata).toEqual({
      species: "vellum",
      metadata: { x: 1 },
    });
  });

  test("contact with no channels still appears with empty channels array", async () => {
    seedGatewayContact({ id: "lonely" });
    seedAssistantInfo({ id: "lonely", contactType: "human" });

    const result = await new ContactStore().listContactsWithInfo();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("lonely");
    expect(result[0].channels).toEqual([]);
    expect(result[0].interactionCount).toBe(0);
    expect(result[0].lastInteraction).toBeNull();
  });

  test("soft-fails on assistant DB outage: returns ACL shape with null info", async () => {
    seedGatewayContact({ id: "c1" });
    seedGatewayChannel({ id: "ch1", contactId: "c1", interactionCount: 3 });
    seedAssistantInfo({ id: "c1", notes: "should not be seen", contactType: "human" });
    fakeAssistantDb.throwOnQuery = true;

    const result = await new ContactStore().listContactsWithInfo();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("c1");
    expect(result[0].role).toBe("contact");
    expect(result[0].channels).toHaveLength(1);
    // Info fields are null in degraded mode.
    expect(result[0].notes).toBeNull();
    expect(result[0].userFile).toBeNull();
    expect(result[0].contactType).toBeNull();
    expect(result[0].assistantMetadata).toBeNull();
    // ACL/trust fields still populated from gateway.
    expect(result[0].interactionCount).toBe(3);
  });

  test("contact missing from assistant DB (dual-write gap): info null, ACL intact", async () => {
    seedGatewayContact({ id: "gap" });
    seedGatewayChannel({ id: "ch-gap", contactId: "gap" });
    // No assistant info seeded for "gap".

    const result = await new ContactStore().listContactsWithInfo();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("gap");
    expect(result[0].notes).toBeNull();
    expect(result[0].contactType).toBeNull();
    expect(result[0].channels).toHaveLength(1);
  });

  test("empty gateway DB returns empty array", async () => {
    const result = await new ContactStore().listContactsWithInfo();
    expect(result).toEqual([]);
  });

  test("multiple channels on one contact group together", async () => {
    seedGatewayContact({ id: "multi" });
    seedGatewayChannel({ id: "ch-a", contactId: "multi", interactionCount: 1, lastInteraction: 100, createdAt: 100 });
    seedGatewayChannel({ id: "ch-b", contactId: "multi", interactionCount: 4, lastInteraction: 500, createdAt: 200 });
    seedAssistantInfo({ id: "multi", contactType: "human" });

    const result = await new ContactStore().listContactsWithInfo();
    expect(result).toHaveLength(1);
    expect(result[0].channels).toHaveLength(2);
    expect(result[0].interactionCount).toBe(5);
    expect(result[0].lastInteraction).toBe(500);
  });
});

// ── ContactStore.getContactWithInfo ─────────────────────────────────────────

describe("ContactStore.getContactWithInfo", () => {
  test("returns null when contact not in gateway DB", async () => {
    const result = await new ContactStore().getContactWithInfo("nope");
    expect(result).toBeNull();
  });

  test("returns joined shape for a single contact", async () => {
    seedGatewayContact({ id: "c1", role: "guardian" });
    seedGatewayChannel({ id: "ch1", contactId: "c1", interactionCount: 7, lastInteraction: 999 });
    seedAssistantInfo({ id: "c1", notes: "my guardian", contactType: "human" });

    const result = await new ContactStore().getContactWithInfo("c1");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("c1");
    expect(result!.role).toBe("guardian");
    expect(result!.notes).toBe("my guardian");
    expect(result!.interactionCount).toBe(7);
    expect(result!.lastInteraction).toBe(999);
  });

  test("soft-fails on assistant DB outage for single contact", async () => {
    seedGatewayContact({ id: "c1" });
    seedAssistantInfo({ id: "c1", notes: "lost", contactType: "human" });
    fakeAssistantDb.throwOnQuery = true;

    const result = await new ContactStore().getContactWithInfo("c1");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("c1");
    expect(result!.notes).toBeNull();
    expect(result!.contactType).toBeNull();
  });
});

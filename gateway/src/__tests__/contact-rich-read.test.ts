/**
 * Tests for the gateway-native rich contact reads:
 *   - ContactStore.listContactsRich
 *   - ContactStore.getContactRich
 *
 * These assemble the shared ContactRead shape (gateway ACL/identity + assistant
 * info fields) so the daemon can relay its full contact read responses through
 * the gateway IPC surface. The gateway DB is a real (file-backed) DB seeded per
 * test; the assistant DB proxy is mocked behind `fakeAssistantDb` so no daemon
 * is required. Mirrors the pattern in contacts-info-joiner.test.ts.
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

// ── Fake daemon IPC (contacts_info_batch) ────────────────────────────────────
// The info read now goes over typed IPC (`contacts_info_batch`), so we mock
// `ipcCallAssistant` behind `fakeAssistantDb` — the daemon applies the metadata
// gating + JSON parse, so this fake returns already-shaped infos and throws on
// demand to exercise the caller's soft-fail path. Mirrors the mock in
// contacts-info-joiner.test.ts.

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
  reset(): void {
    this.info.clear();
    this.throwOnQuery = false;
  },
};

function shapeInfo(row: FakeInfoRow) {
  let assistantMetadata: {
    species: string;
    metadata: Record<string, unknown> | null;
  } | null = null;
  if (row.contact_type === "assistant" && row.species != null) {
    let metadata: Record<string, unknown> | null = null;
    if (row.metadata) {
      try {
        metadata = JSON.parse(row.metadata) as Record<string, unknown>;
      } catch {
        metadata = null;
      }
    }
    assistantMetadata = { species: row.species, metadata };
  }
  return {
    contactId: row.id,
    notes: row.notes,
    userFile: row.user_file,
    contactType: row.contact_type,
    assistantMetadata,
  };
}

class FakeIpcHandlerError extends Error {}
class FakeIpcTransportError extends Error {}

mock.module("../ipc/assistant-client.js", () => ({
  IpcHandlerError: FakeIpcHandlerError,
  IpcTransportError: FakeIpcTransportError,
  ipcCallAssistant: mock(
    async (method: string, params?: Record<string, unknown>) => {
      if (fakeAssistantDb.throwOnQuery) {
        throw new Error("simulated assistant DB outage");
      }
      if (method === "contacts_info_batch") {
        const contactIds = ((params?.body as { contactIds?: string[] })
          ?.contactIds ?? []) as string[];
        const infos = contactIds
          .map((id) => fakeAssistantDb.info.get(id))
          .filter((r): r is FakeInfoRow => r != null)
          .map(shapeInfo);
        return { infos };
      }
      return {};
    },
  ),
}));

import {
  ContactReadSchema,
  GetContactIpcResponseSchema,
} from "@vellumai/gateway-client/gateway-ipc-contracts";

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
});

afterAll(() => {
  resetGatewayDb();
});

// ── Seed helpers ─────────────────────────────────────────────────────────────

function seedGatewayContact(opts: {
  id: string;
  displayName?: string;
  role?: string;
  updatedAt?: number;
}): void {
  const db = getGatewayDb();
  db.insert(contacts)
    .values({
      id: opts.id,
      displayName: opts.displayName ?? `name-${opts.id}`,
      role: opts.role ?? "contact",
      principalId: null,
      createdAt: opts.updatedAt ?? Date.now(),
      updatedAt: opts.updatedAt ?? Date.now(),
    })
    .run();
}

function seedGatewayChannel(opts: {
  id: string;
  contactId: string;
  type?: string;
  address?: string;
  isPrimary?: boolean;
  status?: string;
  policy?: string;
  verifiedAt?: number | null;
  revokedReason?: string | null;
  blockedReason?: string | null;
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
      address: opts.address ?? `addr-${opts.id}`,
      isPrimary: opts.isPrimary ?? false,
      externalChatId: null,
      status: opts.status ?? "active",
      policy: opts.policy ?? "allow",
      verifiedAt: opts.verifiedAt ?? null,
      verifiedVia: null,
      inviteId: null,
      revokedReason: opts.revokedReason ?? null,
      blockedReason: opts.blockedReason ?? null,
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
  contactType?: string | null;
  species?: string | null;
  metadata?: Record<string, unknown> | null;
}): void {
  fakeAssistantDb.info.set(opts.id, {
    id: opts.id,
    notes: opts.notes ?? null,
    user_file: null,
    contact_type: opts.contactType ?? null,
    species: opts.species ?? null,
    metadata: opts.metadata != null ? JSON.stringify(opts.metadata) : null,
  });
}

// ── listContactsRich ─────────────────────────────────────────────────────────

describe("ContactStore.listContactsRich", () => {
  test("merges gateway ACL + assistant info and validates against ContactReadSchema", async () => {
    seedGatewayContact({ id: "c1", role: "contact", updatedAt: 100 });
    seedGatewayChannel({
      id: "ch1",
      contactId: "c1",
      type: "telegram",
      address: "tg-001",
      status: "active",
      policy: "escalate",
      verifiedAt: 555,
      revokedReason: "spam",
      interactionCount: 4,
      lastInteraction: 900,
    });
    seedAssistantInfo({ id: "c1", notes: "a friend", contactType: "human" });

    const result = await new ContactStore().listContactsRich();
    expect(result).toHaveLength(1);

    // Every returned object validates against the shared contract.
    for (const c of result) expect(ContactReadSchema.parse(c)).toEqual(c);

    const c1 = result[0];
    // Contact-level timestamps projected from the gateway DB.
    expect(c1.createdAt).toBe(100);
    expect(c1.updatedAt).toBe(100);
    // Info fields from assistant DB.
    expect(c1.notes).toBe("a friend");
    expect(c1.contactType).toBe("human");
    // Trust signals derived from gateway channels.
    expect(c1.interactionCount).toBe(4);
    expect(c1.lastInteraction).toBe(900);
    // Channel ACL fields from gateway DB.
    const ch = c1.channels[0];
    expect(ch.status).toBe("active");
    expect(ch.policy).toBe("escalate");
    expect(ch.verifiedAt).toBe(555);
    expect(ch.revokedReason).toBe("spam");
    expect(ch.blockedReason).toBeNull();
    // externalUserId is null here — the daemon's withChannelCompat is the sole
    // producer of that compat field on the relayed payload.
    expect(ch.externalUserId).toBeNull();
  });

  test("orders guardian first, then updatedAt desc", async () => {
    seedGatewayContact({ id: "old", updatedAt: 100 });
    seedGatewayContact({ id: "new", updatedAt: 900 });
    seedGatewayContact({ id: "guard", role: "guardian", updatedAt: 1 });
    seedAssistantInfo({ id: "old", contactType: "human" });
    seedAssistantInfo({ id: "new", contactType: "human" });
    seedAssistantInfo({ id: "guard", contactType: "human" });

    const result = await new ContactStore().listContactsRich();
    expect(result.map((c) => c.id)).toEqual(["guard", "new", "old"]);
  });

  test("honors role filter (gateway DB)", async () => {
    seedGatewayContact({ id: "g", role: "guardian" });
    seedGatewayContact({ id: "c", role: "contact" });
    seedAssistantInfo({ id: "g", contactType: "human" });
    seedAssistantInfo({ id: "c", contactType: "human" });

    const result = await new ContactStore().listContactsRich({
      role: "guardian",
    });
    expect(result.map((c) => c.id)).toEqual(["g"]);
  });

  test("honors limit (capped at 200)", async () => {
    for (let i = 0; i < 5; i++) {
      seedGatewayContact({ id: `c${i}`, updatedAt: i });
      seedAssistantInfo({ id: `c${i}`, contactType: "human" });
    }
    const result = await new ContactStore().listContactsRich({ limit: 2 });
    expect(result).toHaveLength(2);
  });

  test("missing assistant-DB row degrades gracefully (info null, no throw)", async () => {
    seedGatewayContact({ id: "gap" });
    seedGatewayChannel({ id: "ch-gap", contactId: "gap", interactionCount: 3 });
    // No assistant info seeded.

    const result = await new ContactStore().listContactsRich();
    expect(result).toHaveLength(1);
    expect(result[0].notes).toBeNull();
    expect(result[0].contactType).toBeNull();
    // ACL/trust fields still populated from gateway.
    expect(result[0].interactionCount).toBe(3);
    expect(ContactReadSchema.parse(result[0])).toEqual(result[0]);
  });

  test("soft-fails on assistant DB outage: gateway-DB-only fields, no throw", async () => {
    seedGatewayContact({ id: "c1" });
    seedGatewayChannel({ id: "ch1", contactId: "c1", interactionCount: 2 });
    seedAssistantInfo({ id: "c1", notes: "unseen", contactType: "human" });
    fakeAssistantDb.throwOnQuery = true;

    const result = await new ContactStore().listContactsRich();
    expect(result).toHaveLength(1);
    expect(result[0].notes).toBeNull();
    expect(result[0].contactType).toBeNull();
    expect(result[0].interactionCount).toBe(2);
  });

  test("empty gateway DB returns empty array", async () => {
    const result = await new ContactStore().listContactsRich();
    expect(result).toEqual([]);
  });

  test("ids filter restricts to the given contact ids, bypassing role/limit", async () => {
    for (const id of ["a", "b", "c"]) {
      seedGatewayContact({ id, role: "contact" });
      seedGatewayChannel({
        id: `ch-${id}`,
        contactId: id,
        interactionCount: id === "b" ? 5 : 1,
        lastInteraction: id === "b" ? 42 : null,
      });
      seedAssistantInfo({ id, contactType: "human" });
    }

    const result = await new ContactStore().listContactsRich({
      ids: ["b", "c"],
      // role/limit are ignored when ids is present.
      role: "guardian",
      limit: 1,
    });

    expect(result.map((c) => c.id).sort()).toEqual(["b", "c"]);
    const b = result.find((c) => c.id === "b")!;
    expect(b.interactionCount).toBe(5);
    expect(b.lastInteraction).toBe(42);
  });

  test("ids filter returns empty for an empty id set", async () => {
    seedGatewayContact({ id: "a" });
    seedAssistantInfo({ id: "a", contactType: "human" });
    const result = await new ContactStore().listContactsRich({ ids: [] });
    expect(result).toEqual([]);
  });

  test("ids filter dedupes and ignores unknown ids", async () => {
    seedGatewayContact({ id: "a" });
    seedGatewayChannel({ id: "ch-a", contactId: "a", interactionCount: 2 });
    seedAssistantInfo({ id: "a", contactType: "human" });

    const result = await new ContactStore().listContactsRich({
      ids: ["a", "a", "ghost"],
    });
    expect(result.map((c) => c.id)).toEqual(["a"]);
    expect(result[0].interactionCount).toBe(2);
  });

  test("primary channel appears first regardless of creation order", async () => {
    seedGatewayContact({ id: "c1" });
    seedGatewayChannel({ id: "ch-old", contactId: "c1", createdAt: 100 });
    seedGatewayChannel({
      id: "ch-primary",
      contactId: "c1",
      isPrimary: true,
      createdAt: 200,
    });
    seedAssistantInfo({ id: "c1", contactType: "human" });

    const result = await new ContactStore().listContactsRich();
    expect(result[0].channels.map((c) => c.id)).toEqual([
      "ch-primary",
      "ch-old",
    ]);
  });
});

// ── getContactRich ───────────────────────────────────────────────────────────

describe("ContactStore.getContactRich", () => {
  test("returns null when contact not in gateway DB", async () => {
    const result = await new ContactStore().getContactRich("nope");
    expect(result).toBeNull();
  });

  test("returns merged ContactRead validating against the response contract", async () => {
    seedGatewayContact({ id: "c1", role: "guardian", updatedAt: 321 });
    seedGatewayChannel({
      id: "ch1",
      contactId: "c1",
      interactionCount: 7,
      lastInteraction: 999,
    });
    seedAssistantInfo({ id: "c1", notes: "my guardian", contactType: "human" });

    const result = await new ContactStore().getContactRich("c1");
    expect(result).not.toBeNull();
    expect(result!.contact.id).toBe("c1");
    expect(result!.contact.role).toBe("guardian");
    expect(result!.contact.notes).toBe("my guardian");
    expect(result!.contact.interactionCount).toBe(7);
    expect(result!.contact.createdAt).toBe(321);
    expect(result!.contact.updatedAt).toBe(321);
    expect(result!.assistantMetadata).toBeUndefined();

    // Validate against the get-contact IPC response contract.
    const payload = { ok: true, contact: result!.contact };
    expect(() => GetContactIpcResponseSchema.parse(payload)).not.toThrow();
  });

  test("includes assistantMetadata for assistant-species contacts", async () => {
    seedGatewayContact({ id: "bot" });
    seedGatewayChannel({ id: "ch-bot", contactId: "bot" });
    seedAssistantInfo({
      id: "bot",
      contactType: "assistant",
      species: "vellum",
      metadata: { model: "opus" },
    });

    const result = await new ContactStore().getContactRich("bot");
    expect(result!.assistantMetadata).toEqual({
      contactId: "bot",
      species: "vellum",
      metadata: { model: "opus" },
    });

    const payload = {
      ok: true,
      contact: result!.contact,
      assistantMetadata: result!.assistantMetadata,
    };
    expect(() => GetContactIpcResponseSchema.parse(payload)).not.toThrow();
  });

  test("missing assistant-DB row degrades gracefully (info null, no throw)", async () => {
    seedGatewayContact({ id: "gap" });
    seedGatewayChannel({ id: "ch-gap", contactId: "gap", interactionCount: 1 });

    const result = await new ContactStore().getContactRich("gap");
    expect(result).not.toBeNull();
    expect(result!.contact.notes).toBeNull();
    expect(result!.contact.contactType).toBeNull();
    expect(result!.contact.interactionCount).toBe(1);
    expect(result!.assistantMetadata).toBeUndefined();
  });

  test("soft-fails on assistant DB outage for single contact", async () => {
    seedGatewayContact({ id: "c1" });
    seedAssistantInfo({ id: "c1", notes: "lost", contactType: "human" });
    fakeAssistantDb.throwOnQuery = true;

    const result = await new ContactStore().getContactRich("c1");
    expect(result).not.toBeNull();
    expect(result!.contact.notes).toBeNull();
    expect(result!.contact.contactType).toBeNull();
  });
});

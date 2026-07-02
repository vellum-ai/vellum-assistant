/**
 * Tests for the contact IPC write handlers (mark_channel_revoked,
 * get_guardian_contact, upsert_verified_channel).
 *
 * The handlers delegate to ContactStore and project results into the
 * contract-shaped envelopes. The assistant DB proxy is mocked behind a
 * per-test fake so the assistant-mirror paths can be exercised without a
 * running daemon.
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, mock } from "bun:test";

import "./test-preload.js";

type FakeChannelRow = {
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
  reset(): void {
    this.channels.clear();
    this.contacts.clear();
  },
};

// Mock the assistant DB proxy before importing the handlers. The fake honors
// `SELECT ... FROM contact_channels WHERE id = ?` and
// `SELECT ... FROM contacts WHERE id = ?`; all other SELECTs return [].
mock.module("../db/assistant-db-proxy.js", () => ({
  assistantDbRun: mock(async () => ({ changes: 1, lastInsertRowid: 0 })),
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

// resolveGatewayChannel resolves the assistant channel's (type,address) via the
// typed identity-lookup IPC; serve it from the same fake channel store.
mock.module("../ipc/contacts-info-client.js", () => ({
  lookupContactChannelIdentity: mock(
    async (selector: { channelId?: string }) => {
      if (selector.channelId == null) return null;
      const row = fakeAssistantDb.channels.get(selector.channelId);
      return row
        ? {
            id: row.id,
            contactId: row.contact_id,
            type: row.type,
            address: row.address,
            externalChatId:
              (row as { external_chat_id?: string | null }).external_chat_id ??
              null,
            displayName: null,
          }
        : null;
    },
  ),
}));

import { eq } from "drizzle-orm";

import { contactRoutes } from "../ipc/contact-handlers.js";
import {
  initGatewayDb,
  getGatewayDb,
  resetGatewayDb,
} from "../db/connection.js";
import { contacts, contactChannels } from "../db/schema.js";

const markChannelRevokedHandler = contactRoutes.find(
  (r) => r.method === "mark_channel_revoked",
)!.handler;

const upsertVerifiedChannelHandler = contactRoutes.find(
  (r) => r.method === "upsert_verified_channel",
)!.handler;

const getGuardianContactHandler = contactRoutes.find(
  (r) => r.method === "get_guardian_contact",
)!.handler;

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

function seedChannel(opts: { id: string; contactId: string; status?: string }) {
  const now = Date.now();
  getGatewayDb()
    .insert(contactChannels)
    .values({
      id: opts.id,
      contactId: opts.contactId,
      type: "vellum",
      address: `addr-${opts.id}`,
      isPrimary: false,
      status: opts.status ?? "unverified",
      policy: "allow",
      interactionCount: 0,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

describe("mark_channel_revoked IPC handler", () => {
  test("downgrades a contact channel to revoked + reason and returns the envelope", async () => {
    seedContact("c1", "contact");
    seedChannel({ id: "ch1", contactId: "c1", status: "active" });

    const res = (await markChannelRevokedHandler({
      contactChannelId: "ch1",
      reason: "guardian_binding_revoked",
    })) as {
      ok: boolean;
      didWrite: boolean;
      channel: { status: string; revokedReason: string | null };
    };

    expect(res.ok).toBe(true);
    expect(res.didWrite).toBe(true);
    expect(res.channel.status).toBe("revoked");
    expect(res.channel.revokedReason).toBe("guardian_binding_revoked");

    const row = getGatewayDb()
      .select()
      .from(contactChannels)
      .where(eq(contactChannels.id, "ch1"))
      .get();
    expect(row!.status).toBe("revoked");
    expect(row!.revokedReason).toBe("guardian_binding_revoked");
  });

  test("guardian guard rejects a non-binding downgrade of a guardian channel", async () => {
    seedContact("g1", "guardian");
    seedChannel({ id: "gch1", contactId: "g1", status: "active" });

    await expect(
      markChannelRevokedHandler({
        contactChannelId: "gch1",
        reason: "some_other_reason",
      }),
    ).rejects.toThrow(/guardian channel/i);

    // Row is untouched — the guard rejects before any write.
    const row = getGatewayDb()
      .select()
      .from(contactChannels)
      .where(eq(contactChannels.id, "gch1"))
      .get();
    expect(row!.status).toBe("active");
  });

  test("allows the sanctioned guardian-binding teardown on a guardian channel", async () => {
    seedContact("g1", "guardian");
    seedChannel({ id: "gch1", contactId: "g1", status: "active" });

    const res = (await markChannelRevokedHandler({
      contactChannelId: "gch1",
      reason: "guardian_binding_revoked",
    })) as { ok: boolean; channel: { status: string } };

    expect(res.ok).toBe(true);
    expect(res.channel.status).toBe("revoked");
  });

  test("does not downgrade a blocked channel (preserves block + reason)", async () => {
    seedContact("c1", "contact");
    seedChannel({ id: "ch1", contactId: "c1", status: "blocked" });
    getGatewayDb()
      .update(contactChannels)
      .set({ blockedReason: "abuse" })
      .where(eq(contactChannels.id, "ch1"))
      .run();

    const res = (await markChannelRevokedHandler({
      contactChannelId: "ch1",
      reason: "guardian_binding_revoked",
    })) as { ok: boolean; didWrite: boolean; channel: { status: string } };

    expect(res.ok).toBe(true);
    expect(res.didWrite).toBe(false);
    expect(res.channel.status).toBe("blocked");

    const row = getGatewayDb()
      .select()
      .from(contactChannels)
      .where(eq(contactChannels.id, "ch1"))
      .get();
    expect(row!.status).toBe("blocked");
    expect(row!.blockedReason).toBe("abuse");
    expect(row!.revokedReason).toBeNull();
  });

  test("throws on a missing channel id (no silent success)", async () => {
    await expect(
      markChannelRevokedHandler({ contactChannelId: "nonexistent" }),
    ).rejects.toThrow(/not found/);
  });
});

describe("get_guardian_contact IPC handler", () => {
  test("returns the guardian contact id(s) from the gateway DB", async () => {
    seedContact("g1", "guardian");
    seedContact("c1", "contact");

    const res = (await getGuardianContactHandler({})) as {
      ok: boolean;
      guardianIds: string[];
    };

    expect(res.ok).toBe(true);
    expect(res.guardianIds).toEqual(["g1"]);
  });

  test("excludes non-guardian contacts", async () => {
    seedContact("c1", "contact");
    seedContact("c2", "contact");

    const res = (await getGuardianContactHandler({})) as {
      ok: boolean;
      guardianIds: string[];
    };

    expect(res.ok).toBe(true);
    expect(res.guardianIds).toEqual([]);
  });
});

describe("upsert_verified_channel IPC handler", () => {
  test("creates + verifies a new gateway channel and returns it", async () => {
    const before = Date.now();
    const res = (await upsertVerifiedChannelHandler({
      type: "vellum",
      address: "addr-new",
      externalChatId: "chat-new",
    })) as {
      ok: boolean;
      verified: boolean;
      channel: {
        id: string;
        contactId: string;
        type: string;
        address: string;
        status: string;
        verifiedAt: number | null;
        verifiedVia: string | null;
      };
    };

    expect(res.ok).toBe(true);
    expect(res.verified).toBe(true);
    expect(res.channel.type).toBe("vellum");
    expect(res.channel.address).toBe("addr-new");
    expect(res.channel.status).toBe("active");
    expect(res.channel.verifiedVia).toBe("challenge");
    expect(res.channel.verifiedAt!).toBeGreaterThanOrEqual(before);

    const row = getGatewayDb()
      .select()
      .from(contactChannels)
      .where(eq(contactChannels.type, "vellum"))
      .get();
    expect(row!.status).toBe("active");
  });

  test("updates an existing unverified gateway channel to verified", async () => {
    seedContact("c1", "contact");
    seedChannel({ id: "ch1", contactId: "c1", status: "unverified" });

    const res = (await upsertVerifiedChannelHandler({
      type: "vellum",
      address: "addr-ch1",
      externalChatId: "chat-1",
    })) as { ok: boolean; verified: boolean; channel: { status: string } };

    expect(res.ok).toBe(true);
    expect(res.verified).toBe(true);
    expect(res.channel.status).toBe("active");

    const row = getGatewayDb()
      .select()
      .from(contactChannels)
      .where(eq(contactChannels.id, "ch1"))
      .get();
    expect(row!.status).toBe("active");
    expect(row!.verifiedAt).not.toBeNull();
  });

  test("does not reactivate a blocked gateway channel (verified:false, no channel)", async () => {
    seedContact("c1", "contact");
    seedChannel({ id: "ch1", contactId: "c1", status: "blocked" });

    const res = (await upsertVerifiedChannelHandler({
      type: "vellum",
      address: "addr-ch1",
      externalChatId: "chat-1",
    })) as { ok: boolean; verified: boolean; channel?: unknown };

    expect(res.ok).toBe(true);
    expect(res.verified).toBe(false);
    expect(res.channel).toBeUndefined();

    const row = getGatewayDb()
      .select()
      .from(contactChannels)
      .where(eq(contactChannels.id, "ch1"))
      .get();
    expect(row!.status).toBe("blocked");
  });

  test("does not reactivate a revoked gateway channel (verified:false)", async () => {
    seedContact("c1", "contact");
    seedChannel({ id: "ch1", contactId: "c1", status: "revoked" });

    const res = (await upsertVerifiedChannelHandler({
      type: "vellum",
      address: "addr-ch1",
      externalChatId: "chat-1",
    })) as { ok: boolean; verified: boolean };

    expect(res.ok).toBe(true);
    expect(res.verified).toBe(false);

    const row = getGatewayDb()
      .select()
      .from(contactChannels)
      .where(eq(contactChannels.id, "ch1"))
      .get();
    expect(row!.status).toBe("revoked");
  });

  test("forwards allowRevokedReactivation: reactivates a revoked channel on the invite path", async () => {
    seedContact("c1", "contact");
    seedChannel({ id: "ch1", contactId: "c1", status: "revoked" });

    const res = (await upsertVerifiedChannelHandler({
      type: "vellum",
      address: "addr-ch1",
      externalChatId: "chat-1",
      verifiedVia: "invite",
      allowRevokedReactivation: true,
    })) as { ok: boolean; verified: boolean; channel: { status: string } };

    expect(res.ok).toBe(true);
    expect(res.verified).toBe(true);
    expect(res.channel.status).toBe("active");

    const row = getGatewayDb()
      .select()
      .from(contactChannels)
      .where(eq(contactChannels.id, "ch1"))
      .get();
    expect(row!.status).toBe("active");
  });

  test("forwards allowRevokedReactivation but still refuses a blocked channel", async () => {
    seedContact("c1", "contact");
    seedChannel({ id: "ch1", contactId: "c1", status: "blocked" });

    const res = (await upsertVerifiedChannelHandler({
      type: "vellum",
      address: "addr-ch1",
      externalChatId: "chat-1",
      verifiedVia: "invite",
      allowRevokedReactivation: true,
    })) as { ok: boolean; verified: boolean };

    expect(res.ok).toBe(true);
    expect(res.verified).toBe(false);

    const row = getGatewayDb()
      .select()
      .from(contactChannels)
      .where(eq(contactChannels.id, "ch1"))
      .get();
    expect(row!.status).toBe("blocked");
  });

  test("round-trips verifiedVia=\"invite\" (free string, not the restricted enum)", async () => {
    const res = (await upsertVerifiedChannelHandler({
      type: "vellum",
      address: "addr-invite",
      externalChatId: "chat-invite",
      verifiedVia: "invite",
    })) as { ok: boolean; verified: boolean; channel: { verifiedVia: string } };

    expect(res.ok).toBe(true);
    expect(res.verified).toBe(true);
    expect(res.channel.verifiedVia).toBe("invite");

    const row = getGatewayDb()
      .select()
      .from(contactChannels)
      .where(eq(contactChannels.address, "addr-invite"))
      .get();
    expect(row!.verifiedVia).toBe("invite");
  });
});

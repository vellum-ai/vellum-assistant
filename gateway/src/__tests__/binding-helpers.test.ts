/**
 * Tests for the guardian binding-helper lookups, which read the gateway DB
 * (source of truth for ACL). The gateway DB is a real (file-backed) DB seeded
 * per test; the assistant DB proxy is mocked and throws on read so the tests
 * prove the lookups never touch the assistant mirror. revokeExistingChannel
 * Guardian still writes both the assistant UPDATE and the gateway dual-write.
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

// Assistant DB proxy: reads throw (lookups must not touch it); the revoke
// UPDATE is captured so we can assert the assistant mirror write still fires.
// A simple in-memory `contact_channels` model lets us prove the id-keyed
// update vs. the (type,address) logical-key fallback under id-divergence.
const assistantRunCalls: { sql: string; bind?: unknown[] }[] = [];

type AsstChannel = {
  id: string;
  type: string;
  address: string;
  status: string;
  policy: string;
};
const asstChannels: AsstChannel[] = [];

function seedAsstChannel(c: AsstChannel): void {
  asstChannels.push(c);
}

mock.module("../db/assistant-db-proxy.js", () => ({
  assistantDbQuery: mock(async () => {
    throw new Error("assistant DB read not expected in binding lookups");
  }),
  assistantDbRun: mock(async (sql: string, bind?: unknown[]) => {
    assistantRunCalls.push({ sql, bind });
    let changes = 0;
    if (/WHERE id = \?/.test(sql)) {
      const id = bind?.[1];
      for (const ch of asstChannels) {
        if (ch.id === id) {
          ch.status = "revoked";
          ch.policy = "deny";
          changes++;
        }
      }
    } else if (/WHERE type = \? AND address = \?/.test(sql)) {
      const type = bind?.[1];
      const address = bind?.[2];
      for (const ch of asstChannels) {
        if (
          ch.type === type &&
          ch.address.toLowerCase() === String(address).toLowerCase()
        ) {
          ch.status = "revoked";
          ch.policy = "deny";
          changes++;
        }
      }
    }
    return { changes, lastInsertRowid: 0 };
  }),
  assistantDbExec: mock(async () => undefined),
}));

import {
  getExistingGuardianBinding,
  getMostRecentChannelGuardianTimestamp,
  resolveCanonicalPrincipal,
  revokeExistingChannelGuardian,
} from "../verification/binding-helpers.js";
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
  assistantRunCalls.length = 0;
  asstChannels.length = 0;
});

afterAll(() => {
  resetGatewayDb();
});

let seq = 0;

function seedContact(opts: {
  id: string;
  role?: string;
  principalId?: string | null;
}): void {
  getGatewayDb()
    .insert(contacts)
    .values({
      id: opts.id,
      displayName: `name-${opts.id}`,
      role: opts.role ?? "contact",
      principalId: opts.principalId ?? null,
      createdAt: 100,
      updatedAt: 100,
    })
    .run();
}

function seedChannel(opts: {
  id?: string;
  contactId: string;
  type: string;
  address?: string;
  status: string;
  createdAt?: number;
  updatedAt?: number | null;
}): string {
  const id = opts.id ?? `ch-${seq++}`;
  getGatewayDb()
    .insert(contactChannels)
    .values({
      id,
      contactId: opts.contactId,
      type: opts.type,
      address: opts.address ?? `addr-${id}`,
      isPrimary: false,
      externalChatId: null,
      status: opts.status,
      policy: "allow",
      verifiedAt: null,
      verifiedVia: null,
      inviteId: null,
      revokedReason: null,
      blockedReason: null,
      lastSeenAt: null,
      interactionCount: 0,
      lastInteraction: null,
      createdAt: opts.createdAt ?? 100,
      updatedAt: opts.updatedAt ?? null,
    })
    .run();
  return id;
}

describe("getExistingGuardianBinding", () => {
  test("returns the active guardian channel address from the gateway DB", async () => {
    seedContact({ id: "g1", role: "guardian" });
    seedChannel({
      contactId: "g1",
      type: "slack",
      address: "U_OWNER",
      status: "active",
    });

    expect(await getExistingGuardianBinding("slack")).toEqual({
      address: "U_OWNER",
    });
  });

  test("returns null when no active guardian binding exists", async () => {
    seedContact({ id: "g1", role: "guardian" });
    seedChannel({ contactId: "g1", type: "slack", status: "revoked" });
    // Non-guardian active channel of the same type must not match.
    seedContact({ id: "c1", role: "contact" });
    seedChannel({ contactId: "c1", type: "slack", status: "active" });

    expect(await getExistingGuardianBinding("slack")).toBeNull();
  });
});

describe("getMostRecentChannelGuardianTimestamp", () => {
  test("returns the max of active + revoked, excluding unverified", async () => {
    seedContact({ id: "g1", role: "guardian" });
    seedChannel({
      contactId: "g1",
      type: "phone",
      status: "active",
      updatedAt: 1000,
    });
    seedChannel({
      contactId: "g1",
      type: "phone",
      status: "revoked",
      updatedAt: 2000,
    });
    // Newer unverified row must be ignored.
    seedChannel({
      contactId: "g1",
      type: "phone",
      status: "unverified",
      updatedAt: 9000,
    });

    expect(await getMostRecentChannelGuardianTimestamp("phone")).toBe(2000);
  });

  test("falls back to created_at when updated_at is null", async () => {
    seedContact({ id: "g1", role: "guardian" });
    seedChannel({
      contactId: "g1",
      type: "phone",
      status: "active",
      createdAt: 1500,
      updatedAt: null,
    });

    expect(await getMostRecentChannelGuardianTimestamp("phone")).toBe(1500);
  });

  test("returns null when no guardian binding has ever existed", async () => {
    expect(await getMostRecentChannelGuardianTimestamp("phone")).toBeNull();
  });
});

describe("resolveCanonicalPrincipal", () => {
  test("returns the guardian's principal from the active vellum channel", async () => {
    seedContact({ id: "g1", role: "guardian", principalId: "principal-owner" });
    seedChannel({ contactId: "g1", type: "vellum", status: "active" });

    expect(await resolveCanonicalPrincipal("fallback")).toBe("principal-owner");
  });

  test("falls back when no active vellum guardian exists", async () => {
    seedContact({ id: "g1", role: "guardian", principalId: "principal-owner" });
    // Active guardian channel of a different type does not satisfy the lookup.
    seedChannel({ contactId: "g1", type: "slack", status: "active" });

    expect(await resolveCanonicalPrincipal("fallback")).toBe("fallback");
  });
});

describe("revokeExistingChannelGuardian", () => {
  test("revokes the gateway channel and mirrors the write to the assistant DB", async () => {
    seedContact({ id: "g1", role: "guardian" });
    const chId = seedChannel({
      contactId: "g1",
      type: "slack",
      address: "U_OWNER",
      status: "active",
    });
    // Assistant row shares the same id — the id-keyed update matches.
    seedAsstChannel({
      id: chId,
      type: "slack",
      address: "U_OWNER",
      status: "active",
      policy: "allow",
    });

    await revokeExistingChannelGuardian("slack");

    // Gateway DB status flipped to revoked.
    const after = getGatewayDb()
      .select()
      .from(contactChannels)
      .all()
      .find((r) => r.id === chId);
    expect(after?.status).toBe("revoked");
    expect(after?.policy).toBe("deny");

    // Assistant mirror revoked via the id-keyed update (no fallback needed).
    expect(assistantRunCalls.length).toBe(1);
    expect(assistantRunCalls[0]!.sql).toContain("WHERE id = ?");
    expect(assistantRunCalls[0]!.bind).toContain(chId);
    expect(asstChannels[0]!.status).toBe("revoked");
    expect(asstChannels[0]!.policy).toBe("deny");
  });

  test("revokes the assistant mirror by (type,address) when ids diverge", async () => {
    seedContact({ id: "g1", role: "guardian" });
    // Gateway guardian channel under id G.
    seedChannel({
      id: "G",
      contactId: "g1",
      type: "slack",
      address: "U_OWNER",
      status: "active",
    });
    // Assistant row shares (type,address) but sits under a DIFFERENT id A.
    seedAsstChannel({
      id: "A",
      type: "slack",
      address: "U_OWNER",
      status: "active",
      policy: "allow",
    });

    await revokeExistingChannelGuardian("slack");

    // id-keyed update missed; logical-key fallback revoked row A.
    expect(asstChannels[0]!.status).toBe("revoked");
    expect(asstChannels[0]!.policy).toBe("deny");
    expect(assistantRunCalls.length).toBe(2);
    expect(assistantRunCalls[0]!.sql).toContain("WHERE id = ?");
    expect(assistantRunCalls[1]!.sql).toContain(
      "WHERE type = ? AND address = ? COLLATE NOCASE",
    );
  });

  test("no-ops (no writes) when no active guardian binding exists", async () => {
    seedContact({ id: "g1", role: "guardian" });
    seedChannel({ contactId: "g1", type: "slack", status: "revoked" });

    await revokeExistingChannelGuardian("slack");

    expect(assistantRunCalls.length).toBe(0);
  });
});

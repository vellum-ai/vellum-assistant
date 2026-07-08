/**
 * Tests for the guardian binding helpers, which read and write the gateway DB
 * (source of truth for ACL). The gateway DB is a real (file-backed) DB seeded
 * per test; the assistant DB proxy is mocked and throws on every call so the
 * tests prove the helpers never touch the assistant mirror.
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

// Assistant DB proxy: every call throws so the tests prove the helpers read
// and write only the gateway DB.
mock.module("../db/assistant-db-proxy.js", () => ({
  assistantDbQuery: mock(async () => {
    throw new Error("assistant DB read not expected in binding helpers");
  }),
  assistantDbRun: mock(async () => {
    throw new Error("assistant DB write not expected in binding helpers");
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
  test("revokes the active guardian channel in the gateway DB only", async () => {
    seedContact({ id: "g1", role: "guardian" });
    const chId = seedChannel({
      contactId: "g1",
      type: "slack",
      address: "U_OWNER",
      status: "active",
    });

    await revokeExistingChannelGuardian("slack");

    const after = getGatewayDb()
      .select()
      .from(contactChannels)
      .all()
      .find((r) => r.id === chId);
    expect(after?.status).toBe("revoked");
    expect(after?.policy).toBe("deny");
  });

  test("revokes every active guardian channel for the type", async () => {
    seedContact({ id: "g1", role: "guardian" });
    const a = seedChannel({
      contactId: "g1",
      type: "slack",
      address: "U_A",
      status: "active",
    });
    const b = seedChannel({
      contactId: "g1",
      type: "slack",
      address: "U_B",
      status: "active",
    });

    await revokeExistingChannelGuardian("slack");

    const rows = getGatewayDb().select().from(contactChannels).all();
    for (const id of [a, b]) {
      const row = rows.find((r) => r.id === id);
      expect(row?.status).toBe("revoked");
      expect(row?.policy).toBe("deny");
    }
  });

  test("no-ops when no active guardian binding exists", async () => {
    seedContact({ id: "g1", role: "guardian" });
    const chId = seedChannel({
      contactId: "g1",
      type: "slack",
      status: "revoked",
    });

    await revokeExistingChannelGuardian("slack");

    const after = getGatewayDb()
      .select()
      .from(contactChannels)
      .all()
      .find((r) => r.id === chId);
    expect(after?.status).toBe("revoked");
  });
});

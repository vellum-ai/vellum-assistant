/**
 * Tests for guardian-bootstrap guardian lookups
 * (findVellumGuardian + findGuardianForChannelActor), which read the gateway
 * DB directly, plus the resolve-or-mint path in resolveOrCreateVellumGuardian
 * (via ensureVellumGuardianBinding / bootstrapGuardian).
 *
 * Guardian rows are seeded ONLY in the gateway DB. By default the assistant
 * DB proxy is swapped for a backend that throws, proving the lookups never
 * read the assistant mirror; mint tests install a real in-memory assistant
 * store so the mirror dual-write succeeds.
 */

import { Database } from "bun:sqlite";

import { and, eq } from "drizzle-orm";

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

// Swappable assistant-DB backend. Default: throw (the gateway reads must
// not touch the assistant mirror). Mint tests install an in-memory DB.
type AssistantBackend = {
  query: (sql: string, params?: unknown[]) => unknown[];
  run: (sql: string, params?: unknown[]) => { changes: number };
  exec: (sql: string) => void;
};

const throwingBackend: AssistantBackend = {
  query: () => {
    throw new Error("assistant DB must not be read by guardian lookups");
  },
  run: () => {
    throw new Error("assistant DB must not be written by guardian lookups");
  },
  exec: () => {
    throw new Error("assistant DB must not be touched by guardian lookups");
  },
};

let assistantBackend: AssistantBackend = throwingBackend;

mock.module("../db/assistant-db-proxy.js", () => ({
  assistantDbQuery: mock(async (sql: string, params?: unknown[]) =>
    assistantBackend.query(sql, params),
  ),
  assistantDbRun: mock(async (sql: string, params?: unknown[]) =>
    assistantBackend.run(sql, params),
  ),
  assistantDbExec: mock(async (sql: string) => assistantBackend.exec(sql)),
}));

import {
  findVellumGuardian,
  findGuardianForChannelActor,
  ensureVellumGuardianBinding,
  bootstrapGuardian,
} from "../auth/guardian-bootstrap.js";
import { initSigningKey } from "../auth/token-service.js";
import {
  initGatewayDb,
  getGatewayDb,
  resetGatewayDb,
} from "../db/connection.js";
import { contacts, contactChannels } from "../db/schema.js";

// Initialize signing key so bootstrapGuardian's JWT minting works.
initSigningKey(Buffer.from("test-signing-key-at-least-32-bytes-long"));

/** Minimal in-memory assistant DB mirroring the contacts/contact_channels schema. */
function makeAssistantBackend(): AssistantBackend {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE contacts (
      id TEXT PRIMARY KEY, display_name TEXT, role TEXT, principal_id TEXT,
      notes TEXT, created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE contact_channels (
      id TEXT PRIMARY KEY, contact_id TEXT, type TEXT, address TEXT,
      external_chat_id TEXT, is_primary INTEGER, status TEXT, policy TEXT,
      verified_at INTEGER, verified_via TEXT, revoked_reason TEXT,
      blocked_reason TEXT, interaction_count INTEGER, created_at INTEGER,
      updated_at INTEGER
    );
  `);
  return {
    query: (sql, params = []) => db.query(sql).all(...(params as never[])),
    run: (sql, params = []) => {
      const r = db.query(sql).run(...(params as never[]));
      return { changes: Number(r.changes) };
    },
    exec: (sql) => db.exec(sql),
  };
}

function seedGuardianChannel(opts: {
  type: string;
  address: string;
  status?: string;
  verifiedAt?: number | null;
  principalId?: string | null;
  contactId?: string;
  channelId?: string;
  role?: string;
}): void {
  const now = Date.now();
  const contactId = opts.contactId ?? `contact-${opts.address}`;
  getGatewayDb()
    .insert(contacts)
    .values({
      id: contactId,
      displayName: `name-${contactId}`,
      role: opts.role ?? "guardian",
      principalId:
        opts.principalId === undefined ? `prin-${contactId}` : opts.principalId,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  getGatewayDb()
    .insert(contactChannels)
    .values({
      id: opts.channelId ?? `channel-${opts.address}`,
      contactId,
      type: opts.type,
      address: opts.address,
      isPrimary: true,
      status: opts.status ?? "active",
      policy: "allow",
      verifiedAt: opts.verifiedAt ?? now,
      interactionCount: 0,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

beforeAll(async () => {
  await initGatewayDb();
});

beforeEach(() => {
  const db = getGatewayDb();
  db.delete(contactChannels).run();
  db.delete(contacts).run();
  assistantBackend = throwingBackend;
});

afterAll(() => {
  resetGatewayDb();
});

describe("findVellumGuardian (gateway DB)", () => {
  test("resolves a guardian seeded only in the gateway DB", async () => {
    seedGuardianChannel({
      type: "vellum",
      address: "vellum-principal-1",
      principalId: "principal-owner",
    });

    const result = await findVellumGuardian();
    expect(result).toEqual({ principalId: "principal-owner" });
  });

  test("returns null when no active vellum guardian channel exists", async () => {
    seedGuardianChannel({
      type: "vellum",
      address: "vellum-principal-1",
      status: "revoked",
      principalId: "principal-owner",
    });

    expect(await findVellumGuardian()).toBeNull();
  });

  test("returns null when the gateway DB is empty", async () => {
    expect(await findVellumGuardian()).toBeNull();
  });

  test("prefers the most recently verified guardian channel", async () => {
    seedGuardianChannel({
      type: "vellum",
      address: "vellum-old",
      contactId: "contact-old",
      channelId: "channel-old",
      verifiedAt: 1000,
      principalId: "principal-old",
    });
    seedGuardianChannel({
      type: "vellum",
      address: "vellum-new",
      contactId: "contact-new",
      channelId: "channel-new",
      verifiedAt: 2000,
      principalId: "principal-new",
    });

    const result = await findVellumGuardian();
    expect(result).toEqual({ principalId: "principal-new" });
  });
});

describe("findGuardianForChannelActor (gateway DB)", () => {
  test("resolves an active guardian binding seeded only in the gateway DB", async () => {
    seedGuardianChannel({
      type: "slack",
      address: "U_OWNER",
      principalId: "principal-owner",
    });

    const result = await findGuardianForChannelActor("slack", "U_OWNER");
    expect(result).toEqual({ principalId: "principal-owner" });
  });

  test("matches the address case-insensitively (COLLATE NOCASE)", async () => {
    seedGuardianChannel({
      type: "slack",
      address: "U_Owner",
      principalId: "principal-owner",
    });

    const result = await findGuardianForChannelActor("slack", "u_owner");
    expect(result).toEqual({ principalId: "principal-owner" });
  });

  test("returns null when no active guardian channel matches", async () => {
    seedGuardianChannel({
      type: "slack",
      address: "U_OWNER",
      status: "revoked",
      principalId: "principal-owner",
    });

    expect(await findGuardianForChannelActor("slack", "U_OWNER")).toBeNull();
    expect(await findGuardianForChannelActor("slack", "U_UNKNOWN")).toBeNull();
  });

  test("does not match a non-guardian contact on the same channel", async () => {
    seedGuardianChannel({
      type: "slack",
      address: "U_OWNER",
      role: "contact",
      principalId: "principal-owner",
    });

    expect(await findGuardianForChannelActor("slack", "U_OWNER")).toBeNull();
  });

  test("returns null for empty inputs without reading any DB", async () => {
    expect(await findGuardianForChannelActor("", "U_OWNER")).toBeNull();
    expect(await findGuardianForChannelActor("slack", "")).toBeNull();
  });
});

describe("resolve-or-mint (resolveOrCreateVellumGuardian)", () => {
  function gatewayVellumGuardians() {
    return getGatewayDb()
      .select({
        principalId: contacts.principalId,
        address: contactChannels.address,
        status: contactChannels.status,
      })
      .from(contacts)
      .innerJoin(contactChannels, eq(contactChannels.contactId, contacts.id))
      .where(
        and(eq(contacts.role, "guardian"), eq(contactChannels.type, "vellum")),
      )
      .all();
  }

  test("returns the existing guardian on a gateway fast-path hit", async () => {
    seedGuardianChannel({
      type: "vellum",
      address: "vellum-principal-existing",
      principalId: "principal-existing",
    });

    const principalId = await ensureVellumGuardianBinding();

    expect(principalId).toBe("principal-existing");
    expect(gatewayVellumGuardians()).toHaveLength(1);
  });

  test("second call hits the gateway fast path (idempotent)", async () => {
    assistantBackend = makeAssistantBackend();

    const principalId = await ensureVellumGuardianBinding();
    expect(principalId).toMatch(/^vellum-principal-/);

    // Gateway now has the row; the assistant DB must not be read again.
    assistantBackend = throwingBackend;
    expect(await ensureVellumGuardianBinding()).toBe(principalId);
    expect(gatewayVellumGuardians()).toHaveLength(1);
  });

  test("mints a fresh principal when the gateway DB has no guardian", async () => {
    assistantBackend = makeAssistantBackend();

    const principalId = await ensureVellumGuardianBinding();

    expect(principalId).toMatch(/^vellum-principal-/);
    const gwRows = gatewayVellumGuardians();
    expect(gwRows).toHaveLength(1);
    expect(gwRows[0]?.principalId).toBe(principalId);
  });

  test("bootstrapGuardian returns the existing guardian (isNew=false)", async () => {
    seedGuardianChannel({
      type: "vellum",
      address: "vellum-principal-existing",
      principalId: "principal-existing",
    });

    const result = await bootstrapGuardian({
      platform: "macos",
      deviceId: "device-1",
    });

    expect(result.guardianPrincipalId).toBe("principal-existing");
    expect(result.isNew).toBe(false);
    expect(result.accessToken).toBeTruthy();
    expect(result.refreshToken).toBeTruthy();
  });

  test("bootstrapGuardian mints a fresh principal when the gateway has none (isNew=true)", async () => {
    assistantBackend = makeAssistantBackend();

    const result = await bootstrapGuardian({
      platform: "macos",
      deviceId: "device-1",
    });

    expect(result.guardianPrincipalId).toMatch(/^vellum-principal-/);
    expect(result.isNew).toBe(true);
  });
});

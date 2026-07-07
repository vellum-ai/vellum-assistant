/**
 * Tests for ContactStore.mergeContacts — gateway-native contact merge.
 *
 * The assistant-DB mirror is ONE transactional daemon op
 * (`contacts_mirror_merge_contact`), so there is no compensation path: these
 * tests pin that the gateway sends the op with the survivor's identity
 * (display name + gateway-resolved user_file slug), that a mirror failure is
 * soft (gateway merge still succeeds), and that no raw db_proxy SQL runs.
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

// ── Mocked daemon IPC ────────────────────────────────────────────────────────

type IpcCall = { method: string; params?: Record<string, unknown> };

const ipcCalls: IpcCall[] = [];
// Method name → error to throw on the next call to it.
const ipcThrowOn = new Map<string, Error>();

mock.module("../ipc/assistant-client.js", () => ({
  ipcCallAssistant: mock(
    async (method: string, params?: Record<string, unknown>) => {
      ipcCalls.push({ method, params });
      const err = ipcThrowOn.get(method);
      if (err) {
        ipcThrowOn.delete(method);
        throw err;
      }
      if (method === "contacts_info_batch") return { infos: [] };
      if (method === "contact_user_file_slugs") return { userFiles: [] };
      return {};
    },
  ),
}));

// The raw-SQL bridge must stay untouched by merges (no compensation path).
const dbProxyRunCalls: { sql: string; bind?: unknown[] }[] = [];
mock.module("../db/assistant-db-proxy.js", () => ({
  assistantDbRun: mock(async (sql: string, bind?: unknown[]) => {
    dbProxyRunCalls.push({ sql, bind });
    return { changes: 0, lastInsertRowid: 0 };
  }),
  assistantDbQuery: mock(async () => []),
  assistantDbExec: mock(async () => undefined),
}));

// ── Imports ──────────────────────────────────────────────────────────────────

import { ContactStore } from "../db/contact-store.js";
import {
  initGatewayDb,
  getGatewayDb,
  resetGatewayDb,
} from "../db/connection.js";
import { contacts, contactChannels } from "../db/schema.js";

// ── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  await initGatewayDb();
});

beforeEach(() => {
  const db = getGatewayDb();
  db.delete(contactChannels).run();
  db.delete(contacts).run();
  ipcCalls.length = 0;
  ipcThrowOn.clear();
  dbProxyRunCalls.length = 0;
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

function mirrorMergeCalls(): IpcCall[] {
  return ipcCalls.filter((c) => c.method === "contacts_mirror_merge_contact");
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("ContactStore.mergeContacts — typed transactional mirror", () => {
  test("sends ONE contacts_mirror_merge_contact op with the survivor identity", async () => {
    seedContact("ct_keep", "contact");
    seedContact("ct_merge", "contact");
    seedChannel({ id: "ch_1", contactId: "ct_merge" });

    const store = new ContactStore();
    const result = await store.mergeContacts("ct_keep", "ct_merge");

    expect(result).not.toBeNull();
    expect(result!.id).toBe("ct_keep");

    const calls = mirrorMergeCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].params).toEqual({
      body: {
        keepContactId: "ct_keep",
        mergeContactId: "ct_merge",
        keepDisplayName: "name-ct_keep",
        // Gateway-resolved slug for the dual-write-gap survivor INSERT.
        resolvedUserFile: "name-ct-keep.md",
      },
    });

    // The typed op is the ONLY mirror write — no raw db_proxy SQL.
    expect(dbProxyRunCalls).toHaveLength(0);
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

  test("mirror op failure is soft: merge succeeds, NO compensation writes", async () => {
    seedContact("ct_keep", "contact");
    seedContact("ct_merge", "contact");
    seedChannel({ id: "ch_1", contactId: "ct_merge" });

    ipcThrowOn.set(
      "contacts_mirror_merge_contact",
      new Error("daemon unavailable"),
    );

    const store = new ContactStore();
    const result = await store.mergeContacts("ct_keep", "ct_merge");

    // Merge succeeded (gateway DB is source of truth).
    expect(result).not.toBeNull();
    expect(result!.id).toBe("ct_keep");

    // The daemon op is transactional, so a failure means NOTHING applied —
    // there is no compensation: no raw db_proxy SQL, no piecemeal mirror ops.
    expect(dbProxyRunCalls).toHaveLength(0);
    const methods = ipcCalls.map((c) => c.method);
    expect(methods).not.toContain("contacts_mirror_delete_contact");
    expect(methods).not.toContain("contacts_mirror_upsert_channel");
    expect(mirrorMergeCalls()).toHaveLength(1);
  });

  test("user_file slug resolution failure is soft: merge succeeds, mirror skipped", async () => {
    seedContact("ct_keep", "contact");
    seedContact("ct_merge", "contact");

    ipcThrowOn.set("contact_user_file_slugs", new Error("daemon unavailable"));

    const store = new ContactStore();
    const result = await store.mergeContacts("ct_keep", "ct_merge");

    expect(result).not.toBeNull();
    expect(result!.id).toBe("ct_keep");
    // Mirror op never sent (resolution failed first), and still no raw SQL.
    expect(mirrorMergeCalls()).toHaveLength(0);
    expect(dbProxyRunCalls).toHaveLength(0);

    // Gateway DB is still consistent: donor gone.
    const remaining = getGatewayDb().select().from(contacts).all();
    expect(remaining.find((c) => c.id === "ct_merge")).toBeUndefined();
  });

  test("guardian donor is rejected before any DB or mirror write", async () => {
    seedContact("ct_keep", "contact");
    seedContact("ct_guardian", "guardian");

    const store = new ContactStore();
    await expect(
      store.mergeContacts("ct_keep", "ct_guardian"),
    ).rejects.toThrow(/guardian/i);

    expect(mirrorMergeCalls()).toHaveLength(0);
    expect(
      getGatewayDb()
        .select()
        .from(contacts)
        .all()
        .find((c) => c.id === "ct_guardian"),
    ).toBeDefined();
  });
});

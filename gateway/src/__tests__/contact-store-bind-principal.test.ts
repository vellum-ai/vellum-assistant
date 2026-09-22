/**
 * Tests for ContactStore.bindContactPrincipal and the reserved-channel-type
 * guard on the generic contact writes.
 *
 * `upsertContact` refuses `role` and `principalId` outright, so binding a
 * principal has its own narrow write. These pin that the write reaches only
 * contact-role rows and never retargets one, and that the generic writes
 * refuse the reserved `vellum` type.
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
import { eq } from "drizzle-orm";

import "./test-preload.js";

// ── Mocked daemon IPC ────────────────────────────────────────────────────────

mock.module("../ipc/assistant-client.js", () => ({
  ipcCallAssistant: mock(async (method: string) => {
    if (method === "contacts_info_batch") {
      return { infos: [] };
    }
    if (method === "contact_user_file_slugs") {
      return { userFiles: [] };
    }
    return {};
  }),
}));

mock.module("../db/assistant-db-proxy.js", () => ({
  assistantDbRun: mock(async () => ({ changes: 0, lastInsertRowid: 0 })),
  assistantDbQuery: mock(async () => []),
  assistantDbExec: mock(async () => undefined),
}));

// ── Imports ──────────────────────────────────────────────────────────────────

import {
  BindContactPrincipalError,
  ContactStore,
  ReservedChannelTypeError,
} from "../db/contact-store.js";
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
});

afterAll(() => {
  resetGatewayDb();
});

function seedContact(opts: {
  id: string;
  role?: "guardian" | "contact";
  principalId?: string | null;
}) {
  const now = Date.now();
  getGatewayDb()
    .insert(contacts)
    .values({
      id: opts.id,
      displayName: `name-${opts.id}`,
      role: opts.role ?? "contact",
      principalId: opts.principalId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function readPrincipal(contactId: string): string | null | undefined {
  return getGatewayDb()
    .select({ principalId: contacts.principalId })
    .from(contacts)
    .where(eq(contacts.id, contactId))
    .get()?.principalId;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("ContactStore.bindContactPrincipal", () => {
  test("binds a principal to a contact-role contact", () => {
    seedContact({ id: "ct_1" });

    new ContactStore().bindContactPrincipal("ct_1", "prin_1");

    expect(readPrincipal("ct_1")).toBe("prin_1");
  });

  test("is idempotent for the same principal", () => {
    seedContact({ id: "ct_1" });
    const store = new ContactStore();

    store.bindContactPrincipal("ct_1", "prin_1");
    store.bindContactPrincipal("ct_1", "prin_1");

    expect(readPrincipal("ct_1")).toBe("prin_1");
  });

  test("refuses a second, different principal", () => {
    seedContact({ id: "ct_1", principalId: "prin_1" });

    expect(() =>
      new ContactStore().bindContactPrincipal("ct_1", "prin_2"),
    ).toThrow(BindContactPrincipalError);
    expect(readPrincipal("ct_1")).toBe("prin_1");
  });

  test("refuses a guardian-role contact", () => {
    seedContact({ id: "ct_guardian", role: "guardian" });

    expect(() =>
      new ContactStore().bindContactPrincipal("ct_guardian", "prin_1"),
    ).toThrow(BindContactPrincipalError);
    expect(readPrincipal("ct_guardian")).toBeNull();
  });

  test("refuses an unknown contact", () => {
    expect(() =>
      new ContactStore().bindContactPrincipal("ct_missing", "prin_1"),
    ).toThrow(BindContactPrincipalError);
  });
});

describe("reserved channel types", () => {
  test("upsertContact refuses a vellum channel", async () => {
    await expect(
      new ContactStore().upsertContact({
        displayName: "Someone",
        channels: [{ type: "vellum", address: "prin_1", isPrimary: true }],
      }),
    ).rejects.toThrow(ReservedChannelTypeError);

    expect(getGatewayDb().select().from(contacts).all()).toHaveLength(0);
  });

  test("the refusal is case-insensitive", async () => {
    await expect(
      new ContactStore().upsertContact({
        channels: [{ type: "Vellum", address: "prin_1" }],
      }),
    ).rejects.toThrow(ReservedChannelTypeError);
  });

  test("a vellum channel alongside another type refuses the whole write", async () => {
    await expect(
      new ContactStore().upsertContact({
        channels: [
          { type: "slack", address: "U123" },
          { type: "vellum", address: "prin_1" },
        ],
      }),
    ).rejects.toThrow(ReservedChannelTypeError);

    expect(getGatewayDb().select().from(contactChannels).all()).toHaveLength(0);
  });

  test("other channel types are unaffected", async () => {
    const { contact } = await new ContactStore().upsertContact({
      displayName: "Slack person",
      channels: [{ type: "slack", address: "U123", isPrimary: true }],
    });

    expect(contact.id).toBeTruthy();
    const channels = new ContactStore().getChannelsForContact(contact.id);
    expect(channels.map((ch) => ch.type)).toEqual(["slack"]);
  });
});

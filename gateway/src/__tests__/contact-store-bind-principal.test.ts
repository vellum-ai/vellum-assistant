/**
 * Tests for ContactStore.bindContactPrincipal, the reserved-channel-type
 * guard on the generic contact writes, and the dedicated vellum-shared writer.
 *
 * `upsertContact` refuses `role` and `principalId` outright, so binding a
 * principal has its own narrow write. These pin that the write reaches only
 * contact-role rows and never retargets one, and that the generic writes
 * refuse the reserved `vellum-shared` type.
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
  writeSharedPrincipalChannel,
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
  test("upsertContact refuses a vellum-shared channel", async () => {
    await expect(
      new ContactStore().upsertContact({
        displayName: "Someone",
        channels: [
          { type: "vellum-shared", address: "prin_1", isPrimary: true },
        ],
      }),
    ).rejects.toThrow(ReservedChannelTypeError);

    expect(getGatewayDb().select().from(contacts).all()).toHaveLength(0);
  });

  test("the refusal is case-insensitive", async () => {
    await expect(
      new ContactStore().upsertContact({
        channels: [{ type: "Vellum-Shared", address: "prin_1" }],
      }),
    ).rejects.toThrow(ReservedChannelTypeError);
  });

  test("a vellum-shared channel alongside another type refuses the whole write", async () => {
    await expect(
      new ContactStore().upsertContact({
        channels: [
          { type: "slack", address: "U123" },
          { type: "vellum-shared", address: "prin_1" },
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

  test("the plain vellum channel type is not reserved", async () => {
    const { contact } = await new ContactStore().upsertContact({
      channels: [{ type: "vellum", address: "prin_1", isPrimary: true }],
    });

    const channels = new ContactStore().getChannelsForContact(contact.id);
    expect(channels.map((ch) => ch.type)).toEqual(["vellum"]);
  });
});

describe("writeSharedPrincipalChannel", () => {
  function sharedChannels() {
    return getGatewayDb()
      .select()
      .from(contactChannels)
      .where(eq(contactChannels.type, "vellum-shared"))
      .all();
  }

  test("binds the principal and records its active vellum-shared channel", () => {
    seedContact({ id: "ct_1" });

    writeSharedPrincipalChannel({
      contactId: "ct_1",
      principalId: "prin_1",
      inviteId: "inv_1",
    });

    expect(readPrincipal("ct_1")).toBe("prin_1");
    const channels = sharedChannels();
    expect(channels).toHaveLength(1);
    expect(channels[0]).toMatchObject({
      contactId: "ct_1",
      address: "prin_1",
      status: "active",
      verifiedVia: "invite",
      inviteId: "inv_1",
    });
    expect(channels[0]!.verifiedAt).toBeNumber();
  });

  test("writes nothing for a contact that cannot take the principal", () => {
    seedContact({ id: "ct_guardian", role: "guardian" });

    expect(() =>
      writeSharedPrincipalChannel({
        contactId: "ct_guardian",
        principalId: "prin_1",
        inviteId: "inv_1",
      }),
    ).toThrow(BindContactPrincipalError);

    expect(readPrincipal("ct_guardian")).toBeNull();
    expect(sharedChannels()).toHaveLength(0);
  });

  test("leaves the contact unbound when the channel write fails", () => {
    seedContact({ id: "ct_1" });
    seedContact({ id: "ct_2" });
    writeSharedPrincipalChannel({
      contactId: "ct_1",
      principalId: "prin_1",
      inviteId: "inv_1",
    });

    expect(() =>
      writeSharedPrincipalChannel({
        contactId: "ct_2",
        principalId: "prin_1",
        inviteId: "inv_2",
      }),
    ).toThrow();

    expect(readPrincipal("ct_2")).toBeNull();
    expect(sharedChannels().map((ch) => ch.contactId)).toEqual(["ct_1"]);
  });
});

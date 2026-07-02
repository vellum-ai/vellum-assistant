import {
  describe,
  test,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  mock,
} from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type Socket } from "node:net";
import { eq } from "drizzle-orm";

// ── Assistant DB proxy + IPC mocks ──────────────────────────────────────────
// The gateway-native channel write (updateContactChannelCore) resolves
// assistant-side channel IDs and mirrors into the assistant DB over the IPC
// proxy, and emits contacts_changed via ipcCallAssistant. None of that is
// reachable in this unit test, so stub both modules. The gateway DB is the
// source of truth and remains real.
type DbQueryFn = (sql: string, bind?: unknown[]) => Promise<unknown[]>;
let assistantDbQueryMock: ReturnType<typeof mock<DbQueryFn>> = mock(
  async () => [],
);
type DbRunFn = (
  sql: string,
  bind?: unknown[],
) => Promise<{ changes: number; lastInsertRowid: number }>;
let assistantDbRunMock: ReturnType<typeof mock<DbRunFn>> = mock(async () => ({
  changes: 1,
  lastInsertRowid: 0,
}));

mock.module("../db/assistant-db-proxy.js", () => ({
  assistantDbQuery: (...args: Parameters<DbQueryFn>) =>
    assistantDbQueryMock(...args),
  assistantDbRun: (...args: Parameters<DbRunFn>) => assistantDbRunMock(...args),
}));

// Spread the actual module so the real IpcHandlerError/IpcTransportError
// classes (and untouched exports like ipcSuggestTrustRule) stay importable by
// later-loaded files when suites share a bun process.
const actualAssistantClient = await import("../ipc/assistant-client.js");
mock.module("../ipc/assistant-client.js", () => ({
  ...actualAssistantClient,
  ipcCallAssistant: mock(async () => ({})),
}));

import { GatewayIpcServer } from "../ipc/server.js";
import { contactRoutes } from "../ipc/contact-handlers.js";
import { ContactStore } from "../db/contact-store.js";
import { contacts, contactChannels } from "../db/schema.js";
import { connectClient, sendRequest } from "./helpers/ipc-newline-client.js";
import {
  initGatewayDb,
  getGatewayDb,
  resetGatewayDb,
} from "../db/connection.js";
import { testWorkspaceDir } from "./test-preload.js";

const socketPath = join(testWorkspaceDir, "gateway.sock");

beforeAll(async () => {
  await initGatewayDb();
});

beforeEach(() => {
  const db = getGatewayDb();
  db.delete(contactChannels).run();
  db.delete(contacts).run();
  // Reset assistant-proxy stubs to their permissive defaults: no assistant-side
  // channel resolution, dual-write succeeds.
  assistantDbQueryMock = mock(async () => []);
  assistantDbRunMock = mock(async () => ({ changes: 1, lastInsertRowid: 0 }));
});

afterAll(() => {
  resetGatewayDb();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seedTestData(): void {
  const db = getGatewayDb();
  const now = Date.now();

  db.delete(contactChannels).run();
  db.delete(contacts).run();

  db.insert(contacts)
    .values([
      {
        id: "c1",
        displayName: "Test Guardian",
        role: "guardian",
        principalId: "p1",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "c2",
        displayName: "Test Contact",
        role: "contact",
        principalId: null,
        createdAt: now,
        updatedAt: now,
      },
    ])
    .run();

  db.insert(contactChannels)
    .values([
      {
        id: "ch1",
        contactId: "c1",
        type: "telegram",
        address: "tg-fake-001",
        isPrimary: true,
        externalChatId: "chat-fake-001",
        status: "active",
        policy: "allow",
        interactionCount: 5,
        createdAt: now,
      },
      {
        id: "ch2",
        contactId: "c1",
        type: "slack",
        address: "UFAKE00001",
        isPrimary: false,
        externalChatId: "DFAKE00001",
        status: "active",
        policy: "allow",
        interactionCount: 10,
        createdAt: now,
      },
      {
        id: "ch3",
        contactId: "c2",
        type: "email",
        address: "test@example.com",
        isPrimary: true,
        externalChatId: null,
        status: "unverified",
        policy: "escalate",
        interactionCount: 0,
        createdAt: now,
      },
    ])
    .run();
}

// ---------------------------------------------------------------------------
// ContactStore unit tests
// ---------------------------------------------------------------------------

describe("ContactStore", () => {
  test("listContacts returns all contacts", () => {
    seedTestData();
    const store = new ContactStore(getGatewayDb());

    const contacts = store.listContacts();
    expect(contacts).toHaveLength(2);
    expect(contacts.map((c) => c.id).sort()).toEqual(["c1", "c2"]);
  });

  test("getContact returns a single contact", () => {
    seedTestData();
    const store = new ContactStore(getGatewayDb());

    const contact = store.getContact("c1");
    expect(contact).toBeDefined();
    expect(contact!.displayName).toBe("Test Guardian");
    expect(contact!.role).toBe("guardian");
  });

  test("getContact returns undefined for unknown id", () => {
    seedTestData();
    const store = new ContactStore(getGatewayDb());

    expect(store.getContact("nonexistent")).toBeUndefined();
  });

  test("getContactByChannel finds contact by channel type and external user id", () => {
    seedTestData();
    const store = new ContactStore(getGatewayDb());

    const contact = store.getContactByChannel("telegram", "tg-fake-001");
    expect(contact).toBeDefined();
    expect(contact!.id).toBe("c1");
  });

  test("getContactByChannel returns undefined for unknown channel", () => {
    seedTestData();
    const store = new ContactStore(getGatewayDb());

    expect(
      store.getContactByChannel("telegram", "nonexistent"),
    ).toBeUndefined();
  });

  test("getChannelsForContact returns all channels for a contact", () => {
    seedTestData();
    const store = new ContactStore(getGatewayDb());

    const channels = store.getChannelsForContact("c1");
    expect(channels).toHaveLength(2);
    expect(channels.map((ch) => ch.type).sort()).toEqual(["slack", "telegram"]);
  });

  test("getChannelsForContact returns empty array for unknown contact", () => {
    seedTestData();
    const store = new ContactStore(getGatewayDb());

    expect(store.getChannelsForContact("nonexistent")).toHaveLength(0);
  });

  test("contact_channels cascade deletes when contact is deleted", () => {
    seedTestData();
    const db = getGatewayDb();
    const store = new ContactStore(db);

    expect(store.getChannelsForContact("c1")).toHaveLength(2);
    db.delete(contacts).where(eq(contacts.id, "c1")).run();
    expect(store.getChannelsForContact("c1")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// IPC route tests
// ---------------------------------------------------------------------------

describe("IPC contact routes", () => {
  let server: InstanceType<typeof GatewayIpcServer>;
  let client: Socket;

  beforeEach(async () => {
    if (existsSync(socketPath)) {
      rmSync(socketPath);
    }
  });

  afterEach(() => {
    client?.destroy();
    server?.stop();
  });

  async function startServerAndConnect(): Promise<void> {
    server = new GatewayIpcServer([...contactRoutes]);
    (server as unknown as { socketPath: string }).socketPath = socketPath;
    server.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    client = await connectClient(socketPath);
  }

  test("list_contacts returns seeded contacts via IPC", async () => {
    seedTestData();

    await startServerAndConnect();
    const res = await sendRequest(client, "list_contacts");

    expect(res.error).toBeUndefined();
    const contacts = res.result as { id: string; displayName: string }[];
    expect(contacts).toHaveLength(2);
  });

  test("get_contact returns a specific contact via IPC", async () => {
    seedTestData();

    await startServerAndConnect();
    const res = await sendRequest(client, "get_contact", { contactId: "c1" });

    expect(res.error).toBeUndefined();
    const contact = res.result as { id: string; displayName: string };
    expect(contact.id).toBe("c1");
    expect(contact.displayName).toBe("Test Guardian");
  });

  test("get_contact returns null for unknown contact", async () => {
    seedTestData();

    await startServerAndConnect();
    const res = await sendRequest(client, "get_contact", {
      contactId: "nonexistent",
    });

    expect(res.error).toBeUndefined();
    // IPC handlers normalize undefined → null for JSON serialization
    expect(res.result).toBeNull();
  });

  test("get_contact_by_channel resolves contact from channel info", async () => {
    seedTestData();

    await startServerAndConnect();
    const res = await sendRequest(client, "get_contact_by_channel", {
      channelType: "slack",
      externalUserId: "UFAKE00001",
    });

    expect(res.error).toBeUndefined();
    const contact = res.result as { id: string };
    expect(contact.id).toBe("c1");
  });

  test("get_channels_for_contact returns channel list", async () => {
    seedTestData();

    await startServerAndConnect();
    const res = await sendRequest(client, "get_channels_for_contact", {
      contactId: "c1",
    });

    expect(res.error).toBeUndefined();
    const channels = res.result as { id: string; type: string }[];
    expect(channels).toHaveLength(2);
  });

  test("get_contact validates params", async () => {
    await startServerAndConnect();
    const res = await sendRequest(client, "get_contact", {});

    expect(res.error).toBeDefined();
    expect(res.error).toContain("Invalid params");
  });

  // -------------------------------------------------------------------------
  // create_contact (gateway DB source of truth via ContactStore.upsertContact)
  // -------------------------------------------------------------------------
  //
  // No assistant daemon runs in these tests, so the best-effort assistant-DB
  // dual-write inside upsertContact soft-fails. The gateway write still
  // succeeds and { contactId, channelId } is returned regardless.

  test("create_contact writes the gateway DB contacts + contact_channels rows", async () => {
    await startServerAndConnect();
    const res = await sendRequest(client, "create_contact", {
      channelType: "email",
      address: "new@example.com",
      displayName: "New Person",
    });

    expect(res.error).toBeUndefined();
    const { contactId, channelId } = res.result as {
      contactId: string;
      channelId: string;
    };
    expect(contactId).toBeTruthy();
    expect(channelId).toBeTruthy();

    // The gateway DB (source of truth) holds both the contact and channel rows.
    const store = new ContactStore(getGatewayDb());
    const contact = store.getContact(contactId);
    expect(contact).toBeDefined();
    expect(contact!.displayName).toBe("New Person");
    // role is always "contact" — guardian binding is not settable here.
    expect(contact!.role).toBe("contact");

    const channels = store.getChannelsForContact(contactId);
    expect(channels).toHaveLength(1);
    expect(channels[0].id).toBe(channelId);
    // The gateway mints a fresh channel UUID on create.
    expect(channels[0].id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(channels[0].type).toBe("email");
    expect(channels[0].address).toBe("new@example.com");
    expect(channels[0].isPrimary).toBe(true);
    // A freshly created channel lands at the unverified admission tier: this is
    // what makes a guardian-denied sender resolve as `unverified_contact` (not
    // trusted, not an unknown stranger) on subsequent inbound.
    expect(channels[0].status).toBe("unverified");
  });

  test("create_contact returns { contactId, channelId } both present and non-empty", async () => {
    await startServerAndConnect();
    const res = await sendRequest(client, "create_contact", {
      channelType: "email",
      address: "shape@example.com",
    });

    expect(res.error).toBeUndefined();
    const result = res.result as { contactId: string; channelId: string };
    expect(typeof result.contactId).toBe("string");
    expect(typeof result.channelId).toBe("string");
    expect(result.contactId.length).toBeGreaterThan(0);
    expect(result.channelId.length).toBeGreaterThan(0);
  });

  test("create_contact ignores the role param (guardian binding not settable here)", async () => {
    await startServerAndConnect();
    const res = await sendRequest(client, "create_contact", {
      channelType: "email",
      address: "wannabe-guardian@example.com",
      role: "guardian",
    });

    expect(res.error).toBeUndefined();
    const { contactId } = res.result as { contactId: string };

    const store = new ContactStore(getGatewayDb());
    expect(store.getContact(contactId)!.role).toBe("contact");
  });

  test("create_contact is idempotent for the same (channelType, address)", async () => {
    await startServerAndConnect();
    const first = await sendRequest(client, "create_contact", {
      channelType: "email",
      address: "dup@example.com",
    });
    const second = await sendRequest(client, "create_contact", {
      channelType: "email",
      address: "dup@example.com",
    });

    expect(first.error).toBeUndefined();
    expect(second.error).toBeUndefined();
    const a = first.result as { contactId: string; channelId: string };
    const b = second.result as { contactId: string; channelId: string };
    expect(b.contactId).toBe(a.contactId);
    expect(b.channelId).toBe(a.channelId);

    // No duplicate rows.
    const store = new ContactStore(getGatewayDb());
    expect(store.listContacts()).toHaveLength(1);
    expect(store.getChannelsForContact(a.contactId)).toHaveLength(1);
  });

  test("create_contact retry does not demote an existing active/verified channel", async () => {
    // An already-trusted channel (active + non-allow policy) must survive a
    // retry untouched — passing hard-coded unverified/allow would drop it below
    // the trusted_contacts admission floor.
    const db = getGatewayDb();
    const now = Date.now();
    db.insert(contacts)
      .values({
        id: "trusted-c1",
        displayName: "Trusted Person",
        role: "contact",
        principalId: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(contactChannels)
      .values({
        id: "trusted-ch1",
        contactId: "trusted-c1",
        type: "email",
        address: "trusted@example.com",
        isPrimary: true,
        status: "active",
        policy: "escalate",
        verifiedAt: now,
        verifiedVia: "manual",
        interactionCount: 3,
        createdAt: now,
      })
      .run();

    await startServerAndConnect();
    const res = await sendRequest(client, "create_contact", {
      channelType: "email",
      address: "trusted@example.com",
    });

    expect(res.error).toBeUndefined();
    const { contactId, channelId } = res.result as {
      contactId: string;
      channelId: string;
    };
    expect(contactId).toBe("trusted-c1");
    expect(channelId).toBe("trusted-ch1");

    const store = new ContactStore(db);
    const channels = store.getChannelsForContact("trusted-c1");
    expect(channels).toHaveLength(1);
    // Status/policy/verification preserved — NOT overwritten to unverified/allow.
    expect(channels[0].status).toBe("active");
    expect(channels[0].policy).toBe("escalate");
    expect(channels[0].verifiedAt).toBe(now);
    expect(channels[0].verifiedVia).toBe("manual");
  });

  test("create_contact retry preserves existing displayName + external_chat_id when omitted", async () => {
    // A retry / re-add for an existing contact that already has a custom
    // displayName and a set external_chat_id, called WITHOUT a displayName,
    // must not overwrite the name with the bare address nor clear the chat id.
    const db = getGatewayDb();
    const now = Date.now();
    db.insert(contacts)
      .values({
        id: "named-c1",
        displayName: "Alice In Wonderland",
        role: "contact",
        principalId: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(contactChannels)
      .values({
        id: "named-ch1",
        contactId: "named-c1",
        type: "telegram",
        address: "tg-alice-001",
        isPrimary: true,
        externalChatId: "chat-alice-001",
        status: "active",
        policy: "allow",
        interactionCount: 2,
        createdAt: now,
      })
      .run();

    await startServerAndConnect();
    const res = await sendRequest(client, "create_contact", {
      channelType: "telegram",
      address: "tg-alice-001",
    });

    expect(res.error).toBeUndefined();
    const { contactId, channelId } = res.result as {
      contactId: string;
      channelId: string;
    };
    expect(contactId).toBe("named-c1");
    expect(channelId).toBe("named-ch1");

    const store = new ContactStore(db);
    // displayName preserved — NOT overwritten with the bare address.
    expect(store.getContact("named-c1")!.displayName).toBe(
      "Alice In Wonderland",
    );
    const channels = store.getChannelsForContact("named-c1");
    expect(channels).toHaveLength(1);
    // external_chat_id preserved — sparse upsert must not clear it.
    expect(channels[0].externalChatId).toBe("chat-alice-001");
  });

  test("create_contact retry honors an explicitly supplied displayName", async () => {
    const db = getGatewayDb();
    const now = Date.now();
    db.insert(contacts)
      .values({
        id: "rename-c1",
        displayName: "Old Name",
        role: "contact",
        principalId: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(contactChannels)
      .values({
        id: "rename-ch1",
        contactId: "rename-c1",
        type: "email",
        address: "rename@example.com",
        isPrimary: true,
        status: "active",
        policy: "allow",
        interactionCount: 0,
        createdAt: now,
      })
      .run();

    await startServerAndConnect();
    const res = await sendRequest(client, "create_contact", {
      channelType: "email",
      address: "rename@example.com",
      displayName: "New Name",
    });

    expect(res.error).toBeUndefined();
    const store = new ContactStore(db);
    expect(store.getContact("rename-c1")!.displayName).toBe("New Name");
  });

  test("create_contact retry does not overwrite the assistant-DB display_name when omitted", async () => {
    // Gap A: the gateway row exists with a stale name; the assistant DB holds
    // the user's current (different) name. A retry WITHOUT displayName must
    // leave the assistant-DB name untouched — the UPDATE must omit display_name.
    const db = getGatewayDb();
    const now = Date.now();
    db.insert(contacts)
      .values({
        id: "stale-c1",
        displayName: "Stale Gateway Name",
        role: "contact",
        principalId: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(contactChannels)
      .values({
        id: "stale-ch1",
        contactId: "stale-c1",
        type: "email",
        address: "stale@example.com",
        isPrimary: true,
        status: "active",
        policy: "allow",
        interactionCount: 0,
        createdAt: now,
      })
      .run();

    // Assistant DB has the contact (so the mirror takes the UPDATE branch).
    assistantDbQueryMock = mock(async (sql: string) => {
      if (sql.includes("FROM contacts WHERE id = ?")) {
        return [{ userFile: "current-name.md" }];
      }
      return [];
    });
    const runCalls: { sql: string; bind?: unknown[] }[] = [];
    assistantDbRunMock = mock(async (sql: string, bind?: unknown[]) => {
      runCalls.push({ sql, bind });
      return { changes: 1, lastInsertRowid: 0 };
    });

    await startServerAndConnect();
    const res = await sendRequest(client, "create_contact", {
      channelType: "email",
      address: "stale@example.com",
    });

    expect(res.error).toBeUndefined();

    // The assistant-DB contact UPDATE must NOT touch display_name.
    const contactUpdate = runCalls.find(
      (c) =>
        c.sql.includes("UPDATE contacts") && c.sql.includes("WHERE id = ?"),
    );
    expect(contactUpdate).toBeDefined();
    expect(contactUpdate!.sql).not.toContain("display_name");

    // The gateway row's stale name is likewise preserved (omit-to-preserve).
    expect(new ContactStore(db).getContact("stale-c1")!.displayName).toBe(
      "Stale Gateway Name",
    );
  });

  test("upsertContact with an explicit id does NOT retarget another contact's metadata", async () => {
    // Update path (Problem 2): an edit carries a channel whose (type,address)
    // is owned by a DIFFERENT assistant contact. The assistant mirror must
    // target the provided id — never the other contact — matching the gateway
    // syncChannels skip-on-cross-contact behavior.
    const db = getGatewayDb();
    const now = Date.now();
    db.insert(contacts)
      .values({
        id: "edit-me",
        displayName: "Edit Me",
        role: "contact",
        principalId: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    // The assistant DB reports the channel is owned by "other-contact" and the
    // edited contact already exists by id.
    assistantDbQueryMock = mock(async (sql: string, bind?: unknown[]) => {
      if (
        sql.includes("FROM contact_channels cc") &&
        sql.includes("WHERE cc.type = ?")
      ) {
        return [{ contactId: "other-contact", displayName: "Other" }];
      }
      if (sql.includes("FROM contacts WHERE id = ?")) {
        if (bind?.[0] === "edit-me") return [{ userFile: "edit-me.md" }];
        return [];
      }
      return [];
    });
    const runCalls: { sql: string; bind?: unknown[] }[] = [];
    assistantDbRunMock = mock(async (sql: string, bind?: unknown[]) => {
      runCalls.push({ sql, bind });
      return { changes: 1, lastInsertRowid: 0 };
    });

    const store = new ContactStore(db);
    await store.upsertContact({
      id: "edit-me",
      displayName: "New Name",
      channels: [{ type: "email", address: "shared@example.com" }],
    });

    // The assistant contact UPDATE targets the provided id, never "other-contact".
    const contactUpdate = runCalls.find(
      (c) =>
        c.sql.includes("UPDATE contacts") && c.sql.includes("WHERE id = ?"),
    );
    expect(contactUpdate).toBeDefined();
    expect(contactUpdate!.bind?.at(-1)).toBe("edit-me");
    expect(runCalls.some((c) => c.bind?.includes("other-contact"))).toBe(false);
  });

  test("upsertContact read-back sources ACL from the gateway DB, not assistant defaults", async () => {
    // The assistant mirror defaults a fresh channel to unverified/allow and a
    // contact to role=contact. The read-back must reflect the gateway DB (the
    // just-written source of truth): an active channel and a guardian role.
    const db = getGatewayDb();
    const now = Date.now();
    db.insert(contacts)
      .values({
        id: "guard-1",
        displayName: "Guardian",
        role: "guardian",
        principalId: "prin-guard",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    // Assistant DB info-join degrades to null (default mock returns []); ACL
    // fields still come from the real gateway DB.
    const store = new ContactStore(db);
    const { contact } = await store.upsertContact({
      id: "guard-1",
      channels: [{ type: "email", address: "g@example.com", status: "active" }],
    });

    expect(contact.role).toBe("guardian");
    expect(contact.principalId).toBe("prin-guard");
    expect(contact.channels).toHaveLength(1);
    expect(contact.channels[0].status).toBe("active");
    expect(contact.channels[0].policy).toBe("allow");
  });

  test("create_contact defaults a brand-new contact's displayName to the canonical address", async () => {
    await startServerAndConnect();
    const res = await sendRequest(client, "create_contact", {
      channelType: "email",
      address: "noname@example.com",
    });

    expect(res.error).toBeUndefined();
    const { contactId } = res.result as { contactId: string };

    const store = new ContactStore(getGatewayDb());
    expect(store.getContact(contactId)!.displayName).toBe("noname@example.com");
  });

  test("create_contact applies default unverified/allow to a brand-new channel", async () => {
    await startServerAndConnect();
    const res = await sendRequest(client, "create_contact", {
      channelType: "email",
      address: "fresh@example.com",
    });

    expect(res.error).toBeUndefined();
    const { contactId } = res.result as { contactId: string };

    const store = new ContactStore(getGatewayDb());
    const channels = store.getChannelsForContact(contactId);
    expect(channels).toHaveLength(1);
    expect(channels[0].status).toBe("unverified");
    expect(channels[0].policy).toBe("allow");
  });

  test("create_contact canonicalizes the address so a non-canonical variant matches", async () => {
    await startServerAndConnect();
    // Phone numbers canonicalize to E.164; a variant with spacing/punctuation
    // must resolve to the same channel on the second call.
    const first = await sendRequest(client, "create_contact", {
      channelType: "phone",
      address: "+1 (555) 010-1234",
    });
    const second = await sendRequest(client, "create_contact", {
      channelType: "phone",
      address: "+15550101234",
    });

    expect(first.error).toBeUndefined();
    expect(second.error).toBeUndefined();
    const a = first.result as { contactId: string; channelId: string };
    const b = second.result as { contactId: string; channelId: string };
    expect(b.contactId).toBe(a.contactId);
    expect(b.channelId).toBe(a.channelId);

    const store = new ContactStore(getGatewayDb());
    expect(store.getChannelsForContact(a.contactId)).toHaveLength(1);
  });

  // ── update_contact_channel (gateway-native write) ──────────────────────
  describe("update_contact_channel", () => {
    /** Insert a blocked channel so revoke-of-blocked can be exercised. */
    function seedBlockedChannel(): void {
      const db = getGatewayDb();
      db.insert(contactChannels)
        .values({
          id: "ch_blocked",
          contactId: "c2",
          type: "telegram",
          address: "tg-blocked-001",
          isPrimary: false,
          externalChatId: null,
          status: "blocked",
          policy: "deny",
          interactionCount: 0,
          createdAt: Date.now(),
        })
        .run();
    }

    test("status update succeeds and writes the gateway DB row", async () => {
      seedTestData();
      await startServerAndConnect();

      const res = await sendRequest(client, "update_contact_channel", {
        contactChannelId: "ch3",
        status: "active",
      });

      expect(res.error).toBeUndefined();
      const body = res.result as { ok: boolean; contact?: { id: string } };
      expect(body.ok).toBe(true);
      expect(body.contact?.id).toBe("c2");

      // Gateway DB is the source of truth — the row must reflect the new status.
      const row = getGatewayDb()
        .select()
        .from(contactChannels)
        .where(eq(contactChannels.id, "ch3"))
        .get();
      expect(row?.status).toBe("active");
    });

    test("policy update succeeds and writes the gateway DB row", async () => {
      seedTestData();
      await startServerAndConnect();

      const res = await sendRequest(client, "update_contact_channel", {
        contactChannelId: "ch3",
        policy: "deny",
      });

      expect(res.error).toBeUndefined();
      expect((res.result as { ok: boolean }).ok).toBe(true);

      const row = getGatewayDb()
        .select()
        .from(contactChannels)
        .where(eq(contactChannels.id, "ch3"))
        .get();
      expect(row?.policy).toBe("deny");
    });

    test("invalid status is rejected as a 400", async () => {
      seedTestData();
      await startServerAndConnect();

      const res = await sendRequest(client, "update_contact_channel", {
        contactChannelId: "ch3",
        status: "deleted",
      });

      expect(res.error).toBeDefined();
      expect(res.statusCode).toBe(400);
      expect(res.errorCode).toBe("BAD_REQUEST");
      expect(res.error).toMatch(/status/);
    });

    test("invalid policy is rejected as a 400", async () => {
      seedTestData();
      await startServerAndConnect();

      const res = await sendRequest(client, "update_contact_channel", {
        contactChannelId: "ch3",
        policy: "maybe",
      });

      expect(res.error).toBeDefined();
      expect(res.statusCode).toBe(400);
      expect(res.errorCode).toBe("BAD_REQUEST");
      expect(res.error).toMatch(/policy/);
    });

    test("revoking a blocked channel returns the conflict error", async () => {
      seedTestData();
      seedBlockedChannel();
      await startServerAndConnect();

      const res = await sendRequest(client, "update_contact_channel", {
        contactChannelId: "ch_blocked",
        status: "revoked",
      });

      expect(res.error).toBeDefined();
      expect(res.statusCode).toBe(409);
      expect(res.errorCode).toBe("CONFLICT");
      expect(res.error).toMatch(/blocked/);

      // The blocked row must be untouched.
      const row = getGatewayDb()
        .select()
        .from(contactChannels)
        .where(eq(contactChannels.id, "ch_blocked"))
        .get();
      expect(row?.status).toBe("blocked");
    });

    test("unknown channel ID returns not-found", async () => {
      seedTestData();
      // No assistant-side resolution: the proxy query returns no rows.
      assistantDbQueryMock = mock(async () => []);
      await startServerAndConnect();

      const res = await sendRequest(client, "update_contact_channel", {
        contactChannelId: "does-not-exist",
        status: "active",
      });

      expect(res.error).toBeDefined();
      expect(res.statusCode).toBe(404);
      expect(res.errorCode).toBe("NOT_FOUND");
    });

    test("assistant-side channel ID resolves via backward-compat path", async () => {
      seedTestData();
      // The given ID is unknown to the gateway DB; the assistant DB resolves it
      // to the logical key (contactId, type, address) of the existing gateway
      // channel ch3, which updateChannelStatus then matches.
      assistantDbQueryMock = mock(async () => [
        { contactId: "c2", type: "email", address: "test@example.com" },
      ]);
      await startServerAndConnect();

      const res = await sendRequest(client, "update_contact_channel", {
        contactChannelId: "assistant-side-id",
        status: "active",
      });

      expect(res.error).toBeUndefined();
      expect((res.result as { ok: boolean }).ok).toBe(true);

      // The resolved gateway row (ch3) is the one that gets updated.
      const row = getGatewayDb()
        .select()
        .from(contactChannels)
        .where(eq(contactChannels.id, "ch3"))
        .get();
      expect(row?.status).toBe("active");
    });

    test("tolerates assistant-DB dual-write failure (gateway write still succeeds)", async () => {
      seedTestData();
      // Dual-write to the assistant DB throws; the gateway write is the source
      // of truth and must still succeed.
      assistantDbRunMock = mock(async () => {
        throw new Error("assistant DB down");
      });
      await startServerAndConnect();

      const res = await sendRequest(client, "update_contact_channel", {
        contactChannelId: "ch3",
        status: "revoked",
        reason: "spam",
      });

      expect(res.error).toBeUndefined();
      expect((res.result as { ok: boolean }).ok).toBe(true);

      const row = getGatewayDb()
        .select()
        .from(contactChannels)
        .where(eq(contactChannels.id, "ch3"))
        .get();
      expect(row?.status).toBe("revoked");
    });
  });

  // ── Rich reads (contacts_list_rich / contacts_get_rich) ─────────────────
  //
  // The assistant DB proxy is not available in this test harness, so the rich
  // reads soft-fail the info join (notes/contactType become null) and return
  // the gateway-DB-only ACL shape. We assert the merged ContactRead structure
  // end-to-end over the socket.
  describe("rich reads", () => {
    test("contacts_list_rich returns the merged ContactRead shape via IPC", async () => {
      seedTestData();

      await startServerAndConnect();
      const res = await sendRequest(client, "contacts_list_rich", {});

      expect(res.error).toBeUndefined();
      const body = res.result as {
        ok: boolean;
        contacts: Array<{
          id: string;
          role: string;
          interactionCount: number;
          channels: Array<{ address: string; externalUserId: string | null }>;
        }>;
      };
      expect(body.ok).toBe(true);
      expect(body.contacts).toHaveLength(2);
      // Guardian first (ordering mirrors the daemon's listContacts).
      expect(body.contacts[0].id).toBe("c1");
      expect(body.contacts[0].role).toBe("guardian");
      // Trust signals derived from gateway channels (5 + 10 for the guardian).
      expect(body.contacts[0].interactionCount).toBe(15);
      // externalUserId is null on the gateway rich-read output — the daemon's
      // withChannelCompat is the sole producer of that compat field.
      const ch = body.contacts[0].channels[0];
      expect(ch.externalUserId).toBeNull();
    });

    test("contacts_list_rich honors the role filter via IPC", async () => {
      seedTestData();

      await startServerAndConnect();
      const res = await sendRequest(client, "contacts_list_rich", {
        role: "guardian",
      });

      expect(res.error).toBeUndefined();
      const body = res.result as {
        ok: boolean;
        contacts: Array<{ id: string }>;
      };
      expect(body.contacts.map((c) => c.id)).toEqual(["c1"]);
    });

    test("contacts_get_rich returns a merged contact via IPC", async () => {
      seedTestData();

      await startServerAndConnect();
      const res = await sendRequest(client, "contacts_get_rich", {
        contactId: "c1",
      });

      expect(res.error).toBeUndefined();
      const body = res.result as {
        ok: boolean;
        contact: { id: string; displayName: string; channels: unknown[] };
      };
      expect(body.ok).toBe(true);
      expect(body.contact.id).toBe("c1");
      expect(body.contact.displayName).toBe("Test Guardian");
      expect(body.contact.channels).toHaveLength(2);
    });

    test("contacts_get_rich returns null for unknown contact via IPC", async () => {
      seedTestData();

      await startServerAndConnect();
      const res = await sendRequest(client, "contacts_get_rich", {
        contactId: "nonexistent",
      });

      expect(res.error).toBeUndefined();
      expect(res.result).toBeNull();
    });

    test("contacts_get_rich validates params", async () => {
      await startServerAndConnect();
      const res = await sendRequest(client, "contacts_get_rich", {});

      expect(res.error).toBeDefined();
      expect(res.error).toContain("Invalid params");
    });
  });
});

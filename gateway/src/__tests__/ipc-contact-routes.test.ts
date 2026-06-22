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
import { randomBytes } from "node:crypto";
import { createConnection, type Socket } from "node:net";
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

mock.module("../ipc/assistant-client.js", () => ({
  ipcCallAssistant: mock(async () => ({})),
  IpcHandlerError: class IpcHandlerError extends Error {},
  IpcTransportError: class IpcTransportError extends Error {},
}));

import { GatewayIpcServer } from "../ipc/server.js";
import { contactRoutes } from "../ipc/contact-handlers.js";
import { ContactStore } from "../db/contact-store.js";
import { contacts, contactChannels } from "../db/schema.js";
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

function connectClient(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const client = createConnection(path, () => resolve(client));
    client.on("error", reject);
  });
}

function sendRequest(
  client: Socket,
  method: string,
  params?: Record<string, unknown>,
): Promise<{
  id: string;
  result?: unknown;
  error?: string;
  statusCode?: number;
  errorCode?: string;
}> {
  return new Promise((resolve, reject) => {
    const id = randomBytes(4).toString("hex");
    let buffer = "";

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        client.off("data", onData);
        try {
          resolve(JSON.parse(line));
        } catch (err) {
          reject(err);
        }
      }
    };

    client.on("data", onData);
    const msg = JSON.stringify({ id, method, params });
    client.write(msg + "\n");
  });
}

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
    // No assistant adoption match → a freshly minted UUID, not an adopted id.
    expect(channels[0].id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(channels[0].type).toBe("email");
    expect(channels[0].address).toBe("new@example.com");
    expect(channels[0].isPrimary).toBe(true);
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
      (c) => c.sql.includes("UPDATE contacts") && c.sql.includes("WHERE id = ?"),
    );
    expect(contactUpdate).toBeDefined();
    expect(contactUpdate!.sql).not.toContain("display_name");

    // The gateway row's stale name is likewise preserved (omit-to-preserve).
    expect(new ContactStore(db).getContact("stale-c1")!.displayName).toBe(
      "Stale Gateway Name",
    );
  });

  test("create_contact heals an assistant-only contact onto ONE shared canonical id", async () => {
    // Gap B: a contact+channel exists in the assistant DB but NOT the gateway.
    // upsertContact adopts the existing assistant contact id as the gateway
    // contact id (canonical-id heal), so BOTH DBs are keyed by the same id —
    // the gateway row is created under it, no duplicate assistant INSERT, the
    // name is preserved, and the gateway read join-by-id resolves info.
    const assistantContactId = "assistant-only-c1";
    const assistantChannelId = "assistant-only-ch1";

    assistantDbQueryMock = mock(async (sql: string, bind?: unknown[]) => {
      // Channel lookup by (type,address) → the existing assistant contact id
      // + its display_name (the adoption JOIN).
      if (
        sql.includes("FROM contact_channels cc") &&
        sql.includes("WHERE cc.type = ?")
      ) {
        return [
          { contactId: assistantContactId, displayName: "Existing Person" },
        ];
      }
      // Adoption ACL fetch: ALL of the adopted contact's channels by contact id.
      if (
        sql.includes("FROM contact_channels cc") &&
        sql.includes("WHERE cc.contact_id = ?")
      ) {
        if (bind?.[0] === assistantContactId) {
          return [
            {
              id: assistantChannelId,
              type: "email",
              address: "existing-person@example.com",
              isPrimary: 0,
              externalChatId: null,
              status: "active",
              policy: "escalate",
              verifiedAt: 1700000000000,
              verifiedVia: "manual",
              inviteId: null,
              revokedReason: null,
              blockedReason: null,
            },
          ];
        }
        return [];
      }
      // existingCh lookup keyed on the adopted (assistant) contact id.
      if (
        sql.includes("FROM contact_channels") &&
        sql.includes("WHERE contact_id = ?")
      ) {
        if (bind?.[0] === assistantContactId) {
          return [{ id: assistantChannelId, status: "active" }];
        }
        return [];
      }
      // user_file lookup in the mirror (contact already exists in assistant DB).
      if (sql.includes("FROM contacts WHERE id = ?")) {
        if (bind?.[0] === assistantContactId) {
          return [{ userFile: "existing-person.md" }];
        }
        return [];
      }
      // Read-path info join keyed by the canonical id.
      if (sql.includes("FROM contacts c") && sql.includes("IN (")) {
        if (bind?.includes(assistantContactId)) {
          return [
            {
              id: assistantContactId,
              notes: "knows the family",
              userFile: "existing-person.md",
              contactType: "human",
              species: null,
              metadata: null,
            },
          ];
        }
        return [];
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
      address: "existing-person@example.com",
    });

    expect(res.error).toBeUndefined();
    const { contactId, channelId } = res.result as {
      contactId: string;
      channelId: string;
    };

    // The returned (gateway) id IS the existing assistant id — one canonical id.
    expect(contactId).toBe(assistantContactId);
    // The gateway channel row adopts the assistant channel id (one canonical
    // channel id), so the returned channelId equals it — a follow-up verify by
    // this id can't 404 on a split-brain row.
    expect(channelId).toBe(assistantChannelId);

    // No duplicate assistant contact INSERT; the existing channel is updated,
    // not re-inserted.
    expect(
      runCalls.find((c) => c.sql.includes("INSERT INTO contacts")),
    ).toBeUndefined();
    expect(
      runCalls.find((c) => c.sql.includes("INSERT INTO contact_channels")),
    ).toBeUndefined();

    // The assistant contact UPDATE targets the shared id, name preserved.
    const contactUpdate = runCalls.find(
      (c) => c.sql.includes("UPDATE contacts") && c.sql.includes("WHERE id = ?"),
    );
    expect(contactUpdate).toBeDefined();
    expect(contactUpdate!.bind?.at(-1)).toBe(assistantContactId);
    expect(contactUpdate!.sql).not.toContain("display_name");

    // The gateway DB has the contact + channel under the canonical id, and the
    // adopted assistant contact's custom display_name is preserved on the
    // gateway row (not renamed to the bare channel address).
    const store = new ContactStore(getGatewayDb());
    expect(store.getContact(contactId)).toBeDefined();
    expect(store.getContact(contactId)!.displayName).toBe("Existing Person");
    const gwChannels = store.getChannelsForContact(contactId);
    expect(gwChannels).toHaveLength(1);
    expect(gwChannels[0].address).toBe("existing-person@example.com");
    // Canonical channel id: the gateway row shares the assistant channel's id
    // (not a freshly minted UUID), so verify-by-id resolves the gateway row.
    expect(gwChannels[0].id).toBe(assistantChannelId);

    // The heal must carry the assistant channel's ACL state into the new
    // gateway row — NOT default it to unverified/allow. An active/verified
    // assistant channel stays active/verified (status === "active" is what
    // actor-trust-resolver classifies as trusted_contact), so default
    // trusted_contacts admission keeps trusting the user post-heal.
    expect(gwChannels[0].status).toBe("active");
    expect(gwChannels[0].policy).toBe("escalate");
    expect(gwChannels[0].verifiedAt).toBe(1700000000000);
    expect(gwChannels[0].verifiedVia).toBe("manual");

    // The gateway read join-by-id resolves the assistant info (NOT null) —
    // proof the two DBs converged on one id.
    const withInfo = await store.getContactWithInfo(contactId);
    expect(withInfo).not.toBeNull();
    expect(withInfo!.notes).toBe("knows the family");
    expect(withInfo!.userFile).toBe("existing-person.md");
    expect(withInfo!.contactType).toBe("human");
  });

  test("multi-channel heal adopts id+ACL for EVERY matched channel, not just the first", async () => {
    // HTTP POST /v1/contacts heals an assistant-only contact that owns TWO
    // existing channels, both active/verified with a non-default policy. The
    // gateway INSERT must carry each channel's assistant id + ACL — a prior
    // bug adopted only the first match and inserted the rest as fresh
    // unverified/allow rows, downgrading trust and splitting channel ids.
    const assistantContactId = "multi-c1";

    assistantDbQueryMock = mock(async (sql: string, bind?: unknown[]) => {
      if (
        sql.includes("FROM contact_channels cc") &&
        sql.includes("WHERE cc.type = ?")
      ) {
        return [{ contactId: assistantContactId, displayName: "Two Channels" }];
      }
      if (
        sql.includes("FROM contact_channels cc") &&
        sql.includes("WHERE cc.contact_id = ?")
      ) {
        if (bind?.[0] !== assistantContactId) return [];
        return [
          {
            id: "ach-email",
            type: "email",
            address: "person@example.com",
            isPrimary: 1,
            externalChatId: null,
            status: "active",
            policy: "escalate",
            verifiedAt: 1700000000000,
            verifiedVia: "manual",
            inviteId: null,
            revokedReason: null,
            blockedReason: null,
          },
          {
            id: "ach-tg",
            type: "telegram",
            address: "555123",
            isPrimary: 0,
            externalChatId: "chat-99",
            status: "active",
            policy: "escalate",
            verifiedAt: 1700000001000,
            verifiedVia: "challenge",
            inviteId: null,
            revokedReason: null,
            blockedReason: null,
          },
        ];
      }
      return [];
    });
    assistantDbRunMock = mock(async () => ({
      changes: 1,
      lastInsertRowid: 0,
    }));

    const store = new ContactStore(getGatewayDb());
    const { contact } = await store.upsertContact({
      channels: [
        { type: "email", address: "person@example.com" },
        { type: "telegram", address: "555123" },
      ],
    });

    expect(contact.id).toBe(assistantContactId);
    const gwChannels = store
      .getChannelsForContact(assistantContactId)
      .sort((a, b) => a.type.localeCompare(b.type));
    expect(gwChannels).toHaveLength(2);

    const email = gwChannels.find((c) => c.type === "email")!;
    expect(email.id).toBe("ach-email");
    expect(email.status).toBe("active");
    expect(email.policy).toBe("escalate");
    expect(email.verifiedVia).toBe("manual");

    const tg = gwChannels.find((c) => c.type === "telegram")!;
    expect(tg.id).toBe("ach-tg");
    expect(tg.status).toBe("active");
    expect(tg.policy).toBe("escalate");
    expect(tg.verifiedVia).toBe("challenge");
  });

  test("mixed heal: matched channel adopts id+ACL, genuinely-new channel stays unverified/allow", async () => {
    const assistantContactId = "mixed-c1";

    assistantDbQueryMock = mock(async (sql: string, bind?: unknown[]) => {
      if (
        sql.includes("FROM contact_channels cc") &&
        sql.includes("WHERE cc.type = ?")
      ) {
        return [{ contactId: assistantContactId, displayName: "Mixed" }];
      }
      if (
        sql.includes("FROM contact_channels cc") &&
        sql.includes("WHERE cc.contact_id = ?")
      ) {
        if (bind?.[0] !== assistantContactId) return [];
        return [
          {
            id: "ach-known",
            type: "email",
            address: "known@example.com",
            isPrimary: 1,
            externalChatId: null,
            status: "active",
            policy: "escalate",
            verifiedAt: 1700000000000,
            verifiedVia: "manual",
            inviteId: null,
            revokedReason: null,
            blockedReason: null,
          },
        ];
      }
      return [];
    });
    assistantDbRunMock = mock(async () => ({
      changes: 1,
      lastInsertRowid: 0,
    }));

    const store = new ContactStore(getGatewayDb());
    await store.upsertContact({
      channels: [
        { type: "email", address: "known@example.com" },
        { type: "email", address: "brand-new@example.com" },
      ],
    });

    const gwChannels = store.getChannelsForContact(assistantContactId);
    expect(gwChannels).toHaveLength(2);

    const known = gwChannels.find((c) => c.address === "known@example.com")!;
    expect(known.id).toBe("ach-known");
    expect(known.status).toBe("active");
    expect(known.policy).toBe("escalate");

    const fresh = gwChannels.find((c) => c.address === "brand-new@example.com")!;
    expect(fresh.id).not.toBe("ach-known");
    expect(fresh.status).toBe("unverified");
    expect(fresh.policy).toBe("allow");
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
      (c) => c.sql.includes("UPDATE contacts") && c.sql.includes("WHERE id = ?"),
    );
    expect(contactUpdate).toBeDefined();
    expect(contactUpdate!.bind?.at(-1)).toBe("edit-me");
    expect(
      runCalls.some((c) => c.bind?.includes("other-contact")),
    ).toBe(false);
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
});

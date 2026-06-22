import {
  describe,
  test,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
} from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { eq } from "drizzle-orm";
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
): Promise<{ id: string; result?: unknown; error?: string }> {
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
  // No assistant daemon is running in these tests, so the best-effort
  // assistant-DB dual-write inside upsertContact fails and is soft-failed —
  // the gateway write still succeeds and { contactId, channelId } is still
  // returned (invariant 2). This is exactly what we assert below.

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

    // The gateway DB (source of truth) now has both rows — previously the
    // raw-SQL handler wrote the assistant DB only.
    const store = new ContactStore(getGatewayDb());
    const contact = store.getContact(contactId);
    expect(contact).toBeDefined();
    expect(contact!.displayName).toBe("New Person");
    // role is always "contact" — guardian binding is not settable here.
    expect(contact!.role).toBe("contact");

    const channels = store.getChannelsForContact(contactId);
    expect(channels).toHaveLength(1);
    expect(channels[0].id).toBe(channelId);
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
});

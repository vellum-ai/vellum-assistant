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

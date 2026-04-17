import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync } from "node:fs";
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

beforeEach(async () => {
  resetGatewayDb();
  await initGatewayDb();
});

afterEach(() => {
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
        address: "test-tg-user",
        isPrimary: true,
        externalUserId: "tg-fake-001",
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
        address: "test-slack-user",
        isPrimary: false,
        externalUserId: "UFAKE00001",
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
        externalUserId: null,
        externalChatId: null,
        status: "unverified",
        policy: "escalate",
        interactionCount: 0,
        createdAt: now,
      },
    ])
    .run();
}

/**
 * Create a minimal assistant DB at the expected path
 * ({testWorkspaceDir}/data/db/assistant.db) with guardian data.
 * Returns the DB file path for cleanup.
 */
function seedAssistantDb(): string {
  const dbDir = join(testWorkspaceDir, "data", "db");
  mkdirSync(dbDir, { recursive: true });
  const dbPath = join(dbDir, "assistant.db");

  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      notes TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      role TEXT NOT NULL DEFAULT 'contact',
      principal_id TEXT,
      user_file TEXT,
      contact_type TEXT NOT NULL DEFAULT 'human'
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS contact_channels (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      address TEXT NOT NULL,
      is_primary INTEGER NOT NULL DEFAULT 0,
      external_user_id TEXT,
      external_chat_id TEXT,
      status TEXT NOT NULL DEFAULT 'unverified',
      policy TEXT NOT NULL DEFAULT 'allow',
      verified_at INTEGER,
      verified_via TEXT,
      invite_id TEXT,
      revoked_reason TEXT,
      blocked_reason TEXT,
      last_seen_at INTEGER,
      interaction_count INTEGER NOT NULL DEFAULT 0,
      last_interaction INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER
    )
  `);

  const now = Date.now();
  db.prepare(
    `INSERT INTO contacts (id, display_name, notes, created_at, updated_at, role, principal_id, user_file, contact_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("ast-g1", "Assistant Guardian", "Loves cosmic dinos", now, now, "guardian", "p-ast-1", "guardian.md", "human");

  db.prepare(
    `INSERT INTO contact_channels (id, contact_id, type, address, is_primary, external_user_id, external_chat_id, status, policy, verified_at, interaction_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("ast-ch1", "ast-g1", "telegram", "ast-tg-user", 1, "tg-ast-001", "chat-ast-001", "active", "allow", now, 3, now);

  db.close();
  return dbPath;
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

  test("listGuardianChannels returns guardian with active channels from gateway DB", () => {
    seedTestData();
    const store = new ContactStore(getGatewayDb());

    const result = store.listGuardianChannels();
    expect(result).not.toBeNull();
    expect(result!.contact.id).toBe("c1");
    expect(result!.contact.displayName).toBe("Test Guardian");
    expect(result!.contact.role).toBe("guardian");
    expect(result!.contact.notes).toBeNull();
    expect(result!.contact.userFile).toBeNull();
    expect(result!.contact.contactType).toBe("human");
    expect(result!.channels).toHaveLength(2);
    expect(result!.channels.map((ch) => ch.type).sort()).toEqual([
      "slack",
      "telegram",
    ]);
  });

  test("listGuardianChannels returns null when gateway DB has no guardians", () => {
    // Don't seed any data — gateway DB is empty
    const store = new ContactStore(getGatewayDb());

    const result = store.listGuardianChannels();
    // Falls back to assistant DB, which also doesn't exist in this
    // test env → null
    expect(result).toBeNull();
  });

  test("listGuardianChannels falls back to assistant DB when gateway is empty", () => {
    // Don't seed gateway DB — leave it empty so it falls back
    const assistantDbPath = seedAssistantDb();

    const store = new ContactStore(getGatewayDb());
    const result = store.listGuardianChannels();

    expect(result).not.toBeNull();
    expect(result!.contact.id).toBe("ast-g1");
    expect(result!.contact.displayName).toBe("Assistant Guardian");
    expect(result!.contact.notes).toBe("Loves cosmic dinos");
    expect(result!.contact.userFile).toBe("guardian.md");
    expect(result!.contact.contactType).toBe("human");
    expect(result!.channels).toHaveLength(1);
    expect(result!.channels[0].type).toBe("telegram");
    expect(result!.channels[0].status).toBe("active");

    // Clean up
    rmSync(assistantDbPath);
  });

  test("listGuardianChannels prefers gateway DB over assistant DB", () => {
    seedTestData(); // populate gateway DB
    seedAssistantDb(); // also create assistant DB

    const store = new ContactStore(getGatewayDb());
    const result = store.listGuardianChannels();

    // Should use gateway data, not assistant data
    expect(result).not.toBeNull();
    expect(result!.contact.id).toBe("c1");
    expect(result!.contact.displayName).toBe("Test Guardian");
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

  test("list_guardian_channels returns guardian with active channels via IPC", async () => {
    seedTestData();

    await startServerAndConnect();
    const res = await sendRequest(client, "list_guardian_channels");

    expect(res.error).toBeUndefined();
    const result = res.result as {
      contact: { id: string; displayName: string; notes: string | null };
      channels: { id: string; type: string }[];
    };
    expect(result.contact.id).toBe("c1");
    expect(result.contact.displayName).toBe("Test Guardian");
    expect(result.channels).toHaveLength(2);
  });

  test("list_guardian_channels returns null when no guardian exists via IPC", async () => {
    // Don't seed any data
    await startServerAndConnect();
    const res = await sendRequest(client, "list_guardian_channels");

    expect(res.error).toBeUndefined();
    expect(res.result).toBeNull();
  });
});

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { Database } from "bun:sqlite";

const testDir = join(
  tmpdir(),
  `vellum-ipc-contact-test-${randomBytes(6).toString("hex")}`,
);
const protectedDir = join(testDir, ".vellum", "protected");
const socketPath = join(testDir, "gateway.sock");

const savedWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
const savedGatewaySecurityDir = process.env.GATEWAY_SECURITY_DIR;

beforeEach(() => {
  process.env.VELLUM_WORKSPACE_DIR = testDir;
  process.env.GATEWAY_SECURITY_DIR = protectedDir;
  mkdirSync(protectedDir, { recursive: true });
});

afterEach(() => {
  if (savedWorkspaceDir === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = savedWorkspaceDir;
  }
  if (savedGatewaySecurityDir === undefined) {
    delete process.env.GATEWAY_SECURITY_DIR;
  } else {
    process.env.GATEWAY_SECURITY_DIR = savedGatewaySecurityDir;
  }
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // best effort cleanup
  }
});

const { GatewayIpcServer } = await import("../ipc/server.js");
const { contactRoutes } = await import("../ipc/contact-handlers.js");
const { ContactStore } = await import("../db/contact-store.js");
const { getGatewayDb } = await import("../db/connection.js");

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

function seedTestData(db: Database): void {
  const now = Date.now();

  db.exec(
    `INSERT INTO contacts (id, display_name, notes, role, principal_id, user_file, contact_type, created_at, updated_at)
     VALUES ('c1', 'Vargas', 'Founding engineer', 'guardian', 'p1', NULL, 'human', ${now}, ${now})`,
  );

  db.exec(
    `INSERT INTO contacts (id, display_name, notes, role, principal_id, user_file, contact_type, created_at, updated_at)
     VALUES ('c2', 'Alice', NULL, 'contact', NULL, NULL, 'human', ${now}, ${now})`,
  );

  db.exec(
    `INSERT INTO contact_channels (id, contact_id, type, address, is_primary, external_user_id, external_chat_id, status, policy, interaction_count, created_at)
     VALUES ('ch1', 'c1', 'telegram', 'vargas@tg', 1, 'tg-123', 'chat-456', 'active', 'allow', 5, ${now})`,
  );

  db.exec(
    `INSERT INTO contact_channels (id, contact_id, type, address, is_primary, external_user_id, external_chat_id, status, policy, interaction_count, created_at)
     VALUES ('ch2', 'c1', 'slack', 'U05D5EGNNMS', 0, 'U05D5EGNNMS', 'D09Q9FG277H', 'active', 'allow', 10, ${now})`,
  );

  db.exec(
    `INSERT INTO contact_channels (id, contact_id, type, address, is_primary, external_user_id, external_chat_id, status, policy, interaction_count, created_at)
     VALUES ('ch3', 'c2', 'email', 'alice@example.com', 1, NULL, NULL, 'unverified', 'escalate', 0, ${now})`,
  );
}

// ---------------------------------------------------------------------------
// ContactStore unit tests
// ---------------------------------------------------------------------------

describe("ContactStore", () => {
  test("listContacts returns all contacts", () => {
    const db = getGatewayDb();
    seedTestData(db);
    const store = new ContactStore(db);

    const contacts = store.listContacts();
    expect(contacts).toHaveLength(2);
    expect(contacts.map((c) => c.id).sort()).toEqual(["c1", "c2"]);
  });

  test("getContact returns a single contact", () => {
    const db = getGatewayDb();
    seedTestData(db);
    const store = new ContactStore(db);

    const contact = store.getContact("c1");
    expect(contact).not.toBeNull();
    expect(contact!.displayName).toBe("Vargas");
    expect(contact!.role).toBe("guardian");
  });

  test("getContact returns null for unknown id", () => {
    const db = getGatewayDb();
    seedTestData(db);
    const store = new ContactStore(db);

    expect(store.getContact("nonexistent")).toBeNull();
  });

  test("getContactByChannel finds contact by channel type and external user id", () => {
    const db = getGatewayDb();
    seedTestData(db);
    const store = new ContactStore(db);

    const contact = store.getContactByChannel("telegram", "tg-123");
    expect(contact).not.toBeNull();
    expect(contact!.id).toBe("c1");
  });

  test("getContactByChannel returns null for unknown channel", () => {
    const db = getGatewayDb();
    seedTestData(db);
    const store = new ContactStore(db);

    expect(store.getContactByChannel("telegram", "nonexistent")).toBeNull();
  });

  test("getChannelsForContact returns all channels for a contact", () => {
    const db = getGatewayDb();
    seedTestData(db);
    const store = new ContactStore(db);

    const channels = store.getChannelsForContact("c1");
    expect(channels).toHaveLength(2);
    expect(channels.map((ch) => ch.type).sort()).toEqual(["slack", "telegram"]);
  });

  test("getChannelsForContact returns empty array for unknown contact", () => {
    const db = getGatewayDb();
    seedTestData(db);
    const store = new ContactStore(db);

    expect(store.getChannelsForContact("nonexistent")).toHaveLength(0);
  });

  test("contact_channels cascade deletes when contact is deleted", () => {
    const db = getGatewayDb();
    seedTestData(db);
    const store = new ContactStore(db);

    expect(store.getChannelsForContact("c1")).toHaveLength(2);
    db.exec("DELETE FROM contacts WHERE id = 'c1'");
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
    const db = getGatewayDb();
    seedTestData(db);

    await startServerAndConnect();
    const res = await sendRequest(client, "list_contacts");

    expect(res.error).toBeUndefined();
    const contacts = res.result as { id: string; displayName: string }[];
    expect(contacts).toHaveLength(2);
  });

  test("get_contact returns a specific contact via IPC", async () => {
    const db = getGatewayDb();
    seedTestData(db);

    await startServerAndConnect();
    const res = await sendRequest(client, "get_contact", { contactId: "c1" });

    expect(res.error).toBeUndefined();
    const contact = res.result as { id: string; displayName: string };
    expect(contact.id).toBe("c1");
    expect(contact.displayName).toBe("Vargas");
  });

  test("get_contact returns null for unknown contact", async () => {
    const db = getGatewayDb();
    seedTestData(db);

    await startServerAndConnect();
    const res = await sendRequest(client, "get_contact", {
      contactId: "nonexistent",
    });

    expect(res.error).toBeUndefined();
    expect(res.result).toBeNull();
  });

  test("get_contact_by_channel resolves contact from channel info", async () => {
    const db = getGatewayDb();
    seedTestData(db);

    await startServerAndConnect();
    const res = await sendRequest(client, "get_contact_by_channel", {
      channelType: "slack",
      externalUserId: "U05D5EGNNMS",
    });

    expect(res.error).toBeUndefined();
    const contact = res.result as { id: string };
    expect(contact.id).toBe("c1");
  });

  test("get_channels_for_contact returns channel list", async () => {
    const db = getGatewayDb();
    seedTestData(db);

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
});

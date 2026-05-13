/**
 * IPC route `mirror_invite_create` — integration test against the real
 * GatewayIpcServer + bun-sqlite gateway DB.
 *
 * Verifies:
 *   - Happy path inserts a mirror row.
 *   - Repeated call with same id is idempotent (gateway → status update).
 *   - Zod-validation rejects malformed params before the store is touched.
 *   - Foreign-key violation (unknown contactId) surfaces as an error so
 *     daemon-side log.warn captures it.
 */

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

import { testWorkspaceDir } from "./test-preload.js";

import {
  initGatewayDb,
  getGatewayDb,
  resetGatewayDb,
} from "../db/connection.js";
import { contacts, ingressInvites } from "../db/schema.js";
import { GatewayIpcServer } from "../ipc/server.js";
import {
  _resetInviteStoreForTests,
  inviteRoutes,
} from "../ipc/invite-handlers.js";

const socketPath = join(testWorkspaceDir, "gateway-invite.sock");
const CONTACT_ID = "co-invite-ipc";

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

function basePayload(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    id: "inv-ipc-1",
    sourceChannel: "telegram",
    tokenHash: "tok-h",
    maxUses: 1,
    useCount: 0,
    expiresAt: now + 60_000,
    status: "active",
    contactId: CONTACT_ID,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

beforeAll(async () => {
  await initGatewayDb();
});

beforeEach(() => {
  const db = getGatewayDb();
  db.delete(ingressInvites).run();
  db.delete(contacts).run();
  const now = Date.now();
  db.insert(contacts)
    .values({
      id: CONTACT_ID,
      displayName: "Test Contact",
      role: "contact",
      principalId: null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  _resetInviteStoreForTests();
});

afterAll(() => {
  resetGatewayDb();
});

describe("IPC mirror_invite_create", () => {
  let server: InstanceType<typeof GatewayIpcServer>;
  let client: Socket;

  beforeEach(() => {
    if (existsSync(socketPath)) rmSync(socketPath);
  });

  afterEach(() => {
    client?.destroy();
    server?.stop();
  });

  async function startServerAndConnect(): Promise<void> {
    server = new GatewayIpcServer([...inviteRoutes]);
    (server as unknown as { socketPath: string }).socketPath = socketPath;
    server.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    client = await connectClient(socketPath);
  }

  test("writes a new mirror row via IPC", async () => {
    await startServerAndConnect();
    const res = await sendRequest(client, "mirror_invite_create", basePayload());

    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ id: "inv-ipc-1" });

    const row = getGatewayDb()
      .select()
      .from(ingressInvites)
      .all()
      .find((r) => r.id === "inv-ipc-1");
    expect(row).toBeDefined();
    expect(row!.sourceChannel).toBe("telegram");
    expect(row!.tokenHash).toBe("tok-h");
    expect(row!.contactId).toBe(CONTACT_ID);
  });

  test("is idempotent on id (second call updates, no duplicate)", async () => {
    await startServerAndConnect();
    await sendRequest(client, "mirror_invite_create", basePayload());
    await sendRequest(
      client,
      "mirror_invite_create",
      basePayload({ useCount: 1, status: "redeemed" }),
    );

    const rows = getGatewayDb().select().from(ingressInvites).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.useCount).toBe(1);
    expect(rows[0]!.status).toBe("redeemed");
  });

  test("zod validation rejects malformed params", async () => {
    await startServerAndConnect();

    // Missing required fields (e.g. no contactId, no expiresAt).
    const res = await sendRequest(client, "mirror_invite_create", {
      id: "inv-bad",
    });

    expect(res.error).toBeDefined();
    // Nothing should have been written.
    const rows = getGatewayDb().select().from(ingressInvites).all();
    expect(rows).toHaveLength(0);
  });

  test("foreign-key violation surfaces as an error (unknown contactId)", async () => {
    await startServerAndConnect();
    const res = await sendRequest(
      client,
      "mirror_invite_create",
      basePayload({ contactId: "no-such-contact" }),
    );

    expect(res.error).toBeDefined();
    const rows = getGatewayDb().select().from(ingressInvites).all();
    expect(rows).toHaveLength(0);
  });
});

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
import { GatewayIpcServer } from "../ipc/server.js";
import { inviteRoutes } from "../ipc/invite-handlers.js";
import { ContactStore } from "../db/contact-store.js";
import { contacts, contactChannels, ingressInvites } from "../db/schema.js";
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
  db.delete(ingressInvites).run();
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
    client.write(JSON.stringify({ id, method, params }) + "\n");
  });
}

/** Seed a parent contact (FK target for invites). */
function seedContact(): void {
  const now = Date.now();
  getGatewayDb()
    .insert(contacts)
    .values({
      id: "c1",
      displayName: "Target",
      role: "contact",
      principalId: null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

/** Insert an invite row directly with the supplied lifecycle fields. */
function seedInvite(overrides: {
  id: string;
  status?: string;
  maxUses?: number;
  useCount?: number;
  expiresAt?: number;
}): void {
  const now = Date.now();
  getGatewayDb()
    .insert(ingressInvites)
    .values({
      id: overrides.id,
      sourceChannel: "telegram",
      inviteCodeHash: "hash-" + overrides.id,
      note: null,
      maxUses: overrides.maxUses ?? 1,
      useCount: overrides.useCount ?? 0,
      expiresAt: overrides.expiresAt ?? now + 60_000,
      status: overrides.status ?? "active",
      contactId: "c1",
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

// ---------------------------------------------------------------------------
// IPC route tests
// ---------------------------------------------------------------------------

describe("IPC invite routes", () => {
  let server: InstanceType<typeof GatewayIpcServer>;
  let client: Socket;

  beforeEach(async () => {
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

  // ── record_invite_redemption ───────────────────────────────────────────

  test("record_invite_redemption: validates params", async () => {
    await startServerAndConnect();
    const res = await sendRequest(client, "record_invite_redemption", {});
    expect(res.error).toBeDefined();
    expect(res.error).toContain("Invalid params");
  });

  test("record_invite_redemption: bumps useCount on an active row", async () => {
    seedContact();
    seedInvite({ id: "inv-rec", maxUses: 1, useCount: 0 });
    await startServerAndConnect();

    const res = await sendRequest(client, "record_invite_redemption", {
      inviteId: "inv-rec",
      redeemedByExternalUserId: "u1",
    });
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ ok: true, updated: true, mirrored: true });

    const row = new ContactStore(getGatewayDb()).getInviteById("inv-rec");
    expect(row!.useCount).toBe(1);
    expect(row!.status).toBe("redeemed");
    expect(row!.redeemedByExternalUserId).toBe("u1");
  });

  test("record_invite_redemption: no-ops on an absent legacy row", async () => {
    await startServerAndConnect();

    const res = await sendRequest(client, "record_invite_redemption", {
      inviteId: "legacy-missing",
    });
    expect(res.error).toBeUndefined();
    // Absent row is valid (legacy invite) — no error, just not updated/mirrored.
    expect(res.result).toEqual({ ok: true, updated: false, mirrored: false });
  });

  test("record_invite_redemption: no-ops (updated:false) on a revoked row", async () => {
    seedContact();
    seedInvite({ id: "inv-revoked-rec", status: "revoked" });
    await startServerAndConnect();

    const res = await sendRequest(client, "record_invite_redemption", {
      inviteId: "inv-revoked-rec",
    });
    // Row exists (mirrored:true) but the gated update matched nothing.
    expect(res.result).toEqual({ ok: true, updated: false, mirrored: true });
  });
});

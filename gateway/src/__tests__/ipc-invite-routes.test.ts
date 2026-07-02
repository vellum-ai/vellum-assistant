/**
 * End-to-end tests for the gateway `invites_redeem` IPC route — the method
 * the daemon's explicit redeem routes relay to. Driven over a real Unix
 * socket against a real gateway DB so they pin the full path the daemon
 * exercises: shared param validation (400 over the wire), engine dispatch
 * (token vs voice-code), the response shapes the daemon returns verbatim to
 * the CLI, and the atomic row consumption.
 *
 * The gateway DB is real (shared test preload); the assistant DB mirror and
 * the daemon IPC client are mocked so tests never touch the assistant socket.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";

import { hashInviteCode, hashInviteToken } from "@vellumai/gateway-client";

// The engine's ACL side effect dual-writes an assistant-DB info mirror over
// IPC; stub it so tests never touch a socket.
mock.module("../db/assistant-db-proxy.js", () => ({
  assistantDbQuery: async () => [],
  assistantDbRun: async () => {},
}));

// Capture the best-effort invite_redeemed daemon event instead of dialing
// the assistant socket.
let ipcCallAssistantCalls: Array<{ method: string; body: unknown }> = [];
// Spread the actual module so the real IpcHandlerError/IpcTransportError
// classes (and untouched exports like ipcSuggestTrustRule) stay importable by
// later-loaded files when suites share a bun process.
const actualAssistantClient = await import("../ipc/assistant-client.js");
mock.module("../ipc/assistant-client.js", () => ({
  ...actualAssistantClient,
  ipcCallAssistant: async (method: string, opts?: { body?: unknown }) => {
    ipcCallAssistantCalls.push({ method, body: opts?.body });
    return {};
  },
}));

const { testWorkspaceDir } = await import("./test-preload.js");

const { initGatewayDb, getGatewayDb, resetGatewayDb } =
  await import("../db/connection.js");
const { contacts, contactChannels, ingressInvites } =
  await import("../db/schema.js");
const { ContactStore } = await import("../db/contact-store.js");
const { GatewayIpcServer } = await import("../ipc/server.js");
const { inviteRoutes } = await import("../ipc/invite-handlers.js");

// Short name: the workspace tmp prefix leaves little headroom under the
// AF_UNIX socket-path length limit.
const socketPath = join(testWorkspaceDir, "gw-ir.sock");

const CALLER = "+15555550100";
const CODE = "123456";
const TOKEN = "tok_raw_abc123";
const CHANNEL = "telegram";

beforeAll(async () => {
  await initGatewayDb();
});

beforeEach(() => {
  const db = getGatewayDb();
  db.delete(ingressInvites).run();
  db.delete(contactChannels).run();
  db.delete(contacts).run();
  ipcCallAssistantCalls = [];
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
    client.write(JSON.stringify({ id, method, params }) + "\n");
  });
}

/** Seed a parent contact (FK target for invites). */
function seedContact(displayName = "Target Name"): void {
  const now = Date.now();
  getGatewayDb()
    .insert(contacts)
    .values({
      id: "c1",
      displayName,
      role: "contact",
      principalId: null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function seedTokenInvite(
  overrides: Partial<
    Parameters<InstanceType<typeof ContactStore>["createInvite"]>[0]
  > = {},
): string {
  const id = overrides.id ?? crypto.randomUUID();
  new ContactStore().createInvite({
    id,
    sourceChannel: CHANNEL,
    inviteCodeHash: hashInviteCode(CODE),
    tokenHash: hashInviteToken(TOKEN),
    contactId: "c1",
    maxUses: 1,
    expiresAt: Date.now() + 60_000,
    ...overrides,
  });
  return id;
}

function seedVoiceInvite(): string {
  const id = crypto.randomUUID();
  new ContactStore().createInvite({
    id,
    sourceChannel: "phone",
    voiceCodeHash: hashInviteCode(CODE),
    voiceCodeDigits: 6,
    expectedExternalUserId: CALLER,
    friendName: "Friend Name",
    guardianName: "Guardian Name",
    contactId: "c1",
    maxUses: 1,
    expiresAt: Date.now() + 60_000,
  });
  return id;
}

function inviteRow(id: string) {
  return new ContactStore().getInviteById(id)!;
}

// ---------------------------------------------------------------------------
// invites_redeem IPC route tests
// ---------------------------------------------------------------------------

describe("invites_redeem IPC route", () => {
  let server: InstanceType<typeof GatewayIpcServer>;
  let client: Socket;

  beforeEach(async () => {
    if (existsSync(socketPath)) rmSync(socketPath);
    server = new GatewayIpcServer([...inviteRoutes]);
    (server as unknown as { socketPath: string }).socketPath = socketPath;
    server.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    client = await connectClient(socketPath);
  });

  afterEach(() => {
    client?.destroy();
    server?.stop();
  });

  test("empty params → 400 typed error (token required), nothing consumed", async () => {
    const res = await sendRequest(client, "invites_redeem", {});
    expect(res.error).toBeDefined();
    expect(res.error).toContain("token is required");
    // The daemon relay maps this to a RouteError via the mirrored statusCode.
    expect(res.statusCode).toBe(400);
    expect(res.errorCode).toBe("BAD_REQUEST");
  });

  test("token redeem: consumes the row and returns the sanitized invite + type", async () => {
    seedContact();
    const inviteId = seedTokenInvite();

    const res = await sendRequest(client, "invites_redeem", {
      token: TOKEN,
      sourceChannel: CHANNEL,
      externalUserId: "user-1",
      externalChatId: "chat-1",
    });

    expect(res.error).toBeUndefined();
    const result = res.result as {
      ok: boolean;
      type: string;
      invite: Record<string, unknown>;
    };
    expect(result.ok).toBe(true);
    expect(result.type).toBe("redeemed");
    expect(result.invite.id).toBe(inviteId);
    expect(result.invite.status).toBe("redeemed");
    expect(result.invite.useCount).toBe(1);
    // Redemption secrets never leave the DB.
    expect(result.invite.tokenHash).toBeUndefined();
    expect(result.invite.inviteCodeHash).toBeUndefined();
    expect(result.invite.voiceCodeHash).toBeUndefined();

    // The canonical row was consumed and the daemon info-mirror event fired.
    expect(inviteRow(inviteId).useCount).toBe(1);
    expect(
      ipcCallAssistantCalls.some((c) => c.method === "invite_redeemed"),
    ).toBe(true);
  });

  test("token redeem: unknown token → 400 invalid_token, nothing consumed", async () => {
    seedContact();
    const inviteId = seedTokenInvite();

    const res = await sendRequest(client, "invites_redeem", {
      token: "not-the-token",
      sourceChannel: CHANNEL,
      externalUserId: "user-1",
    });

    expect(res.error).toBeDefined();
    expect(res.error).toContain("invalid_token");
    expect(res.statusCode).toBe(400);
    expect(inviteRow(inviteId).useCount).toBe(0);
  });

  test("voice redeem: returns { ok, type, memberId, inviteId } and consumes the row", async () => {
    seedContact();
    const inviteId = seedVoiceInvite();

    const res = await sendRequest(client, "invites_redeem", {
      code: CODE,
      callerExternalUserId: CALLER,
    });

    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({
      ok: true,
      type: "redeemed",
      memberId: "c1",
      inviteId,
    });
    expect(inviteRow(inviteId).useCount).toBe(1);
    expect(
      ipcCallAssistantCalls.some((c) => c.method === "invite_redeemed"),
    ).toBe(true);
  });

  test("voice redeem: wrong code → 400 generic invalid_or_expired, nothing consumed", async () => {
    seedContact();
    const inviteId = seedVoiceInvite();

    const res = await sendRequest(client, "invites_redeem", {
      code: "000000",
      callerExternalUserId: CALLER,
    });

    expect(res.error).toBeDefined();
    expect(res.error).toContain("invalid_or_expired");
    expect(res.statusCode).toBe(400);
    expect(inviteRow(inviteId).useCount).toBe(0);
    expect(
      ipcCallAssistantCalls.some((c) => c.method === "invite_redeemed"),
    ).toBe(false);
  });

  test("token redeem for an already-active member → already_member, NO use consumed", async () => {
    seedContact();
    const inviteId = seedTokenInvite();
    const now = Date.now();
    getGatewayDb()
      .insert(contactChannels)
      .values({
        id: "ch1",
        contactId: "c1",
        type: CHANNEL,
        address: "user-1",
        externalChatId: "chat-1",
        status: "active",
        policy: "allow",
        interactionCount: 0,
        createdAt: now,
      })
      .run();

    const res = await sendRequest(client, "invites_redeem", {
      token: TOKEN,
      sourceChannel: CHANNEL,
      externalUserId: "user-1",
    });

    expect(res.error).toBeUndefined();
    const result = res.result as { type: string };
    expect(result.type).toBe("already_member");
    expect(inviteRow(inviteId).useCount).toBe(0);
    // Nothing consumed → nothing to mirror.
    expect(
      ipcCallAssistantCalls.some((c) => c.method === "invite_redeemed"),
    ).toBe(false);
  });
});

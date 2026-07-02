/**
 * Tests for the voice-invite IPC routes (ipc/invite-handlers.ts):
 * `get_active_voice_invite` (detection with/without an invite, expired
 * filtering) and `redeem_voice_invite` (success / already_member / generic
 * failure / double-redeem), including the best-effort `invite_redeemed`
 * daemon info-mirror event on success.
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

import { hashInviteCode } from "@vellumai/gateway-client";

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
const socketPath = join(testWorkspaceDir, "gw-vi.sock");

const CALLER = "+15555550100";
const CODE = "123456";

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

function seedContact(displayName = "Target Name"): void {
  const now = Date.now();
  getGatewayDb()
    .insert(contacts)
    .values({
      id: "c1",
      displayName,
      role: "contact",
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function seedVoiceInvite(
  overrides: Partial<
    Parameters<InstanceType<typeof ContactStore>["createInvite"]>[0]
  > = {},
): string {
  const id = overrides.id ?? crypto.randomUUID();
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
    ...overrides,
  });
  return id;
}

function inviteRow(id: string) {
  return new ContactStore().getInviteById(id)!;
}

// ---------------------------------------------------------------------------
// IPC route tests
// ---------------------------------------------------------------------------

describe("voice invite IPC routes", () => {
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

  // ── get_active_voice_invite ────────────────────────────────────────────

  test("get_active_voice_invite: validates params", async () => {
    const res = await sendRequest(client, "get_active_voice_invite", {});
    expect(res.error).toBeDefined();
    expect(res.error).toContain("Invalid params");
  });

  test("get_active_voice_invite: no invite → { invite: null }", async () => {
    const res = await sendRequest(client, "get_active_voice_invite", {
      callerExternalUserId: CALLER,
    });
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ invite: null });
  });

  test("get_active_voice_invite: active invite → display metadata only", async () => {
    seedContact("Curated Name");
    const inviteId = seedVoiceInvite();

    const res = await sendRequest(client, "get_active_voice_invite", {
      callerExternalUserId: CALLER,
    });

    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({
      invite: {
        inviteId,
        inviteeName: "Curated Name",
        guardianName: "Guardian Name",
        codeDigits: 6,
      },
    });
  });

  test("get_active_voice_invite: friendName fallback + codeDigits default", async () => {
    seedContact("");
    const inviteId = seedVoiceInvite({ voiceCodeDigits: null });

    const res = await sendRequest(client, "get_active_voice_invite", {
      callerExternalUserId: CALLER,
    });

    expect(res.result).toEqual({
      invite: {
        inviteId,
        inviteeName: "Friend Name",
        guardianName: "Guardian Name",
        codeDigits: 6,
      },
    });
  });

  test("get_active_voice_invite: expired invite filtered and lazily marked", async () => {
    seedContact();
    const inviteId = seedVoiceInvite({ expiresAt: Date.now() - 1 });

    const res = await sendRequest(client, "get_active_voice_invite", {
      callerExternalUserId: CALLER,
    });

    expect(res.result).toEqual({ invite: null });
    expect(inviteRow(inviteId).status).toBe("expired");
  });

  // ── redeem_voice_invite ────────────────────────────────────────────────

  test("redeem_voice_invite: validates params", async () => {
    const res = await sendRequest(client, "redeem_voice_invite", {
      callerExternalUserId: CALLER,
    });
    expect(res.error).toBeDefined();
    expect(res.error).toContain("Invalid params");
  });

  test("redeem_voice_invite: success → outcome + invite_redeemed daemon event", async () => {
    seedContact("Curated Name");
    const inviteId = seedVoiceInvite();

    const res = await sendRequest(client, "redeem_voice_invite", {
      callerExternalUserId: CALLER,
      code: CODE,
    });

    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({
      ok: true,
      outcome: {
        inviteId,
        contactId: "c1",
        sourceChannel: "phone",
        memberExternalUserId: CALLER,
        memberExternalChatId: CALLER,
        displayName: "Curated Name",
        result: "redeemed",
      },
    });
    expect(inviteRow(inviteId).useCount).toBe(1);
    expect(inviteRow(inviteId).status).toBe("redeemed");

    // The redemption fires the identity-mirror upsert (contacts_mirror_*) and
    // the best-effort invite_redeemed daemon event, both over the same client.
    const redeemedEvents = ipcCallAssistantCalls.filter(
      (c) => c.method === "invite_redeemed",
    );
    expect(redeemedEvents).toHaveLength(1);
    expect(redeemedEvents[0].body).toMatchObject({
      inviteId,
      result: "redeemed",
    });
  });

  test("redeem_voice_invite: already_member → no consume, no daemon event", async () => {
    seedContact();
    const now = Date.now();
    getGatewayDb()
      .insert(contactChannels)
      .values({
        id: "ch-1",
        contactId: "c1",
        type: "phone",
        address: CALLER,
        externalChatId: CALLER,
        status: "active",
        policy: "allow",
        interactionCount: 0,
        createdAt: now,
      })
      .run();
    const inviteId = seedVoiceInvite();

    const res = await sendRequest(client, "redeem_voice_invite", {
      callerExternalUserId: CALLER,
      code: CODE,
    });

    expect(res.error).toBeUndefined();
    expect(res.result).toMatchObject({
      ok: true,
      outcome: { result: "already_member" },
    });
    expect(inviteRow(inviteId).useCount).toBe(0);
    expect(ipcCallAssistantCalls).toHaveLength(0);
  });

  test("redeem_voice_invite: wrong code → generic failure, no consume", async () => {
    seedContact();
    const inviteId = seedVoiceInvite();

    const res = await sendRequest(client, "redeem_voice_invite", {
      callerExternalUserId: CALLER,
      code: "999999",
    });

    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ ok: false, reason: "invalid_or_expired" });
    expect(inviteRow(inviteId).useCount).toBe(0);
    expect(ipcCallAssistantCalls).toHaveLength(0);
  });

  test("redeem_voice_invite: double redeem → second attempt fails generically", async () => {
    seedContact();
    const inviteId = seedVoiceInvite({ maxUses: 1 });

    const first = await sendRequest(client, "redeem_voice_invite", {
      callerExternalUserId: CALLER,
      code: CODE,
    });
    expect(first.result).toMatchObject({ ok: true });

    // Reset the caller's channel so the retry isn't gated as already_member.
    getGatewayDb().delete(contactChannels).run();

    const second = await sendRequest(client, "redeem_voice_invite", {
      callerExternalUserId: CALLER,
      code: CODE,
    });
    expect(second.result).toEqual({ ok: false, reason: "invalid_or_expired" });
    expect(inviteRow(inviteId).useCount).toBe(1);
  });
});

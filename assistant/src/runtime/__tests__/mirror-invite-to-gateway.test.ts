/**
 * mirrorInviteToGateway — daemon-side best-effort behavior.
 *
 * Track B PR-B-1: a mirror failure must NEVER throw to the createIngressInvite
 * caller (the daemon-owned authoritative write is the source of truth). This
 * test pins that contract by mocking the gateway IPC client to reject and
 * asserting the helper resolves normally.
 *
 * Also asserts the wire payload contains every field daemon-side
 * IngressInvite carries — so future schema additions on either side don't
 * silently drift.
 */

import { describe, test, expect, beforeEach, mock } from "bun:test";

type IpcCallArgs = {
  method: string;
  params?: Record<string, unknown>;
};

const ipcCalls: IpcCallArgs[] = [];
let ipcCallImpl: (
  method: string,
  params?: Record<string, unknown>,
) => Promise<unknown> = async () => ({});

mock.module("../../ipc/gateway-client.js", () => ({
  ipcCall: async (method: string, params?: Record<string, unknown>) => {
    ipcCalls.push({ method, params });
    return ipcCallImpl(method, params);
  },
}));

// invite-service pulls a bunch of LLM/channel-adapter modules eagerly. Stub
// the ones that touch real I/O so the import doesn't side-effect.
mock.module("../channel-invite-transport.js", () => ({
  getInviteAdapterRegistry: () => ({}),
  resolveAdapterHandle: () => undefined,
}));
mock.module("../invite-instruction-generator.js", () => ({
  generateInviteInstruction: async () => "",
}));
mock.module("../invite-redemption-service.js", () => ({
  redeemInvite: async () => ({}),
  redeemVoiceInviteCode: async () => ({}),
  redeemInviteByCode: async () => ({}),
}));
mock.module("../calls/call-domain.js", () => ({
  startInviteCall: async () => ({}),
}));

const { mirrorInviteToGateway } = await import("../invite-service.js");

const baseInvite = () => ({
  id: "inv-daemon-1",
  sourceChannel: "telegram",
  tokenHash: "tok-h",
  sourceConversationId: null,
  note: null,
  maxUses: 1,
  useCount: 0,
  expiresAt: Date.now() + 60_000,
  status: "active" as const,
  redeemedByExternalUserId: null,
  redeemedByExternalChatId: null,
  redeemedAt: null,
  expectedExternalUserId: null,
  voiceCodeHash: null,
  voiceCodeDigits: null,
  inviteCodeHash: null,
  friendName: null,
  guardianName: null,
  contactId: "co-1",
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

beforeEach(() => {
  ipcCalls.length = 0;
  ipcCallImpl = async () => ({});
});

describe("mirrorInviteToGateway", () => {
  test("fires mirror_invite_create with the full payload", async () => {
    const invite = baseInvite();
    await mirrorInviteToGateway(invite);

    expect(ipcCalls).toHaveLength(1);
    expect(ipcCalls[0]!.method).toBe("mirror_invite_create");
    const params = ipcCalls[0]!.params!;

    // Spot-check every field that flows over the wire.
    for (const key of [
      "id",
      "sourceChannel",
      "tokenHash",
      "sourceConversationId",
      "note",
      "maxUses",
      "useCount",
      "expiresAt",
      "status",
      "redeemedByExternalUserId",
      "redeemedByExternalChatId",
      "redeemedAt",
      "expectedExternalUserId",
      "voiceCodeHash",
      "voiceCodeDigits",
      "inviteCodeHash",
      "friendName",
      "guardianName",
      "contactId",
      "createdAt",
      "updatedAt",
    ] as const) {
      expect(params).toHaveProperty(key);
    }

    expect(params.id).toBe(invite.id);
    expect(params.contactId).toBe(invite.contactId);
    expect(params.tokenHash).toBe(invite.tokenHash);
  });

  test("swallows IPC errors (best-effort dual-write)", async () => {
    ipcCallImpl = async () => {
      throw new Error("gateway down");
    };

    // The promise must resolve, not reject.
    await expect(mirrorInviteToGateway(baseInvite())).resolves.toBeUndefined();
    expect(ipcCalls).toHaveLength(1);
  });

  test("forwards voice-invite fields when present", async () => {
    const invite = {
      ...baseInvite(),
      sourceChannel: "phone",
      expectedExternalUserId: "+15551234567",
      voiceCodeHash: "voice-h",
      voiceCodeDigits: 6,
      friendName: "Alice",
      guardianName: "Bob",
    };
    await mirrorInviteToGateway(invite);

    const params = ipcCalls[0]!.params!;
    expect(params.sourceChannel).toBe("phone");
    expect(params.expectedExternalUserId).toBe("+15551234567");
    expect(params.voiceCodeHash).toBe("voice-h");
    expect(params.voiceCodeDigits).toBe(6);
    expect(params.friendName).toBe("Alice");
    expect(params.guardianName).toBe("Bob");
  });
});

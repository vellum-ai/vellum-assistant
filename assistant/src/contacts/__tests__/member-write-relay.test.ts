/**
 * Tests for the gateway-first member-activation relay.
 *
 * activateMemberChannel writes the activated channel through the gateway
 * (source of truth) via `ipcCallPersistent("upsert_verified_channel", ...)`
 * first, then mirrors the activation to the assistant DB best-effort. A local
 * mirror failure is swallowed so the gateway-owned outcome stands; a gateway
 * refusal (verified:false) skips the local mirror entirely.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ContactWriteResult } from "../types.js";

type IpcCall = { method: string; params?: Record<string, unknown> };

let ipcCalls: IpcCall[] = [];
let ipcVerified = true;
let ipcThrows = false;
let createContactChannelId = "gw-ch1";
let revokeOk = true;

const ipcCallPersistentMock = mock(
  async (method: string, params?: Record<string, unknown>) => {
    ipcCalls.push({ method, params });
    if (ipcThrows) {
      throw new Error("gateway unavailable");
    }
    if (method === "create_contact") {
      return { contactId: "gw-c1", channelId: createContactChannelId };
    }
    if (method === "mark_channel_revoked") {
      return {
        ok: revokeOk,
        didWrite: true,
        channel: {
          id: (params?.contactChannelId as string) ?? "gw-ch1",
          contactId: "gw-c1",
          type: "slack",
          address: "addr",
          status: "revoked",
          revokedReason: (params?.reason as string) ?? null,
        },
      };
    }
    return {
      ok: true,
      verified: ipcVerified,
      channel: ipcVerified
        ? {
            id: "gw-ch1",
            contactId: (params?.contactId as string) ?? "gw-c1",
            type: (params?.type as string) ?? "telegram",
            address: (params?.address as string) ?? "addr",
            status: "active",
            verifiedAt: 1,
            verifiedVia: (params?.verifiedVia as string) ?? "invite",
          }
        : undefined,
    };
  },
);
const actualGatewayClient = await import("../../ipc/gateway-client.js");
mock.module("../../ipc/gateway-client.js", () => ({
  ...actualGatewayClient,
  ipcCallPersistent: ipcCallPersistentMock,
}));

// Local-mirror primitive.
const localResult: ContactWriteResult = {
  contact: { id: "c1" } as ContactWriteResult["contact"],
  channel: { id: "ch1" } as ContactWriteResult["channel"],
};
let mirrorCallOrder = -1;
const upsertContactChannelMock = mock(
  (_params: Record<string, unknown>): ContactWriteResult | null => {
    mirrorCallOrder = ipcCalls.length;
    return localResult;
  },
);
const actualContactStore = await import("../contact-store.js");
mock.module("../contact-store.js", () => ({
  ...actualContactStore,
  findContactChannel: () => null,
}));

const actualContactsWrite = await import("../contacts-write.js");
mock.module("../contacts-write.js", () => ({
  ...actualContactsWrite,
  upsertContactChannel: upsertContactChannelMock,
}));

const {
  activateMemberChannel,
  blockSenderChannel,
  seedUnverifiedMemberChannel,
} = await import("../member-write-relay.js");

describe("activateMemberChannel gateway-first relay", () => {
  beforeEach(() => {
    ipcCalls = [];
    ipcVerified = true;
    ipcThrows = false;
    mirrorCallOrder = -1;
    ipcCallPersistentMock.mockClear();
    upsertContactChannelMock.mockClear();
    upsertContactChannelMock.mockImplementation(() => {
      mirrorCallOrder = ipcCalls.length;
      return localResult;
    });
  });

  test("relays to the gateway before mirroring locally, threading the target contact", async () => {
    const result = await activateMemberChannel({
      sourceChannel: "telegram",
      externalUserId: "user-1",
      externalChatId: "chat-1",
      displayName: "Mom",
      contactId: "target-mom",
      inviteId: "inv-1",
      verifiedVia: "invite",
    });

    expect(ipcCalls).toEqual([
      {
        method: "upsert_verified_channel",
        params: {
          type: "telegram",
          address: "user-1",
          externalChatId: "chat-1",
          displayName: "Mom",
          username: undefined,
          verifiedVia: "invite",
          contactId: "target-mom",
          allowRevokedReactivation: true,
        },
      },
    ]);
    // The local mirror ran AFTER the gateway relay.
    expect(mirrorCallOrder).toBe(1);
    expect(upsertContactChannelMock).toHaveBeenCalledTimes(1);

    // The local mirror persists identity/INFO only — no ACL columns. The
    // gateway owns status/policy/verification.
    const mirrorArgs = upsertContactChannelMock.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(mirrorArgs).toEqual({
      sourceChannel: "telegram",
      externalUserId: "user-1",
      externalChatId: "chat-1",
      displayName: "Mom",
      username: undefined,
      inviteId: "inv-1",
      contactId: "target-mom",
    });
    for (const aclKey of [
      "status",
      "policy",
      "role",
      "verifiedAt",
      "verifiedVia",
    ]) {
      expect(aclKey in mirrorArgs).toBe(false);
    }

    expect(result).toEqual({
      status: "activated",
      memberId: "ch1",
      member: localResult,
    });
  });

  test("fails closed and skips the local mirror when the gateway relay throws", async () => {
    ipcThrows = true;

    const result = await activateMemberChannel({
      sourceChannel: "telegram",
      externalUserId: "user-1",
      externalChatId: "chat-1",
      contactId: "target-mom",
    });

    expect(ipcCalls).toHaveLength(1);
    // Identity-only mirror would land at the schema-default unverified status, so
    // a failed gateway write must not report success off it.
    expect(upsertContactChannelMock).not.toHaveBeenCalled();
    expect(result).toEqual({ status: "refused" });
  });

  test("returns the gateway channel id when the gateway verifies but the local mirror throws", async () => {
    upsertContactChannelMock.mockImplementation(() => {
      throw new Error("local mirror exploded");
    });

    const result = await activateMemberChannel({
      sourceChannel: "telegram",
      externalUserId: "user-1",
      externalChatId: "chat-1",
    });

    expect(ipcCalls).toHaveLength(1);
    // Gateway activation stands: the gateway channel id is returned even though
    // the best-effort local mirror produced no row.
    expect(result).toEqual({
      status: "activated",
      memberId: "gw-ch1",
      member: null,
    });
  });

  test("refuses when the gateway throws even if the local mirror would have thrown", async () => {
    ipcThrows = true;
    upsertContactChannelMock.mockImplementation(() => {
      throw new Error("local mirror exploded");
    });

    const result = await activateMemberChannel({
      sourceChannel: "telegram",
      externalUserId: "user-1",
      externalChatId: "chat-1",
    });

    // Fail-closed: a thrown gateway write refuses before the mirror is touched.
    expect(upsertContactChannelMock).not.toHaveBeenCalled();
    expect(result).toEqual({ status: "refused" });
  });

  test("refuses the activation when the gateway denies the actor (verified:false)", async () => {
    ipcVerified = false;

    const result = await activateMemberChannel({
      sourceChannel: "telegram",
      externalUserId: "user-1",
      externalChatId: "chat-1",
      contactId: "target-mom",
    });

    expect(ipcCalls).toHaveLength(1);
    expect(upsertContactChannelMock).not.toHaveBeenCalled();
    expect(result).toEqual({ status: "refused" });
  });

  test("derives the address from externalChatId when no externalUserId is present", async () => {
    await activateMemberChannel({
      sourceChannel: "phone",
      externalChatId: "+15551234567",
    });

    expect(ipcCalls[0]?.params).toMatchObject({
      type: "phone",
      address: "+15551234567",
      externalChatId: "+15551234567",
    });
  });
});

describe("seedUnverifiedMemberChannel gateway-first relay", () => {
  beforeEach(() => {
    ipcCalls = [];
    ipcThrows = false;
    ipcCallPersistentMock.mockClear();
  });

  test("relays to the gateway create_contact IPC with channelType + address + displayName", async () => {
    await seedUnverifiedMemberChannel({
      sourceChannel: "telegram",
      externalUserId: "user-1",
      displayName: "Alice",
    });

    expect(ipcCalls).toEqual([
      {
        method: "create_contact",
        params: {
          channelType: "telegram",
          address: "user-1",
          displayName: "Alice",
        },
      },
    ]);
  });

  test("omits displayName when not supplied", async () => {
    await seedUnverifiedMemberChannel({
      sourceChannel: "slack",
      externalUserId: "U123",
    });

    expect(ipcCalls).toHaveLength(1);
    expect(ipcCalls[0]!.method).toBe("create_contact");
    expect(ipcCalls[0]!.params).toEqual({
      channelType: "slack",
      address: "U123",
    });
    expect("displayName" in (ipcCalls[0]!.params ?? {})).toBe(false);
  });

  test("swallows gateway errors (best-effort) so a deny is never blocked", async () => {
    ipcThrows = true;

    // Must not throw — the gateway owns the ACL verdict and a failed seed must
    // not fail the guardian's deny decision.
    await seedUnverifiedMemberChannel({
      sourceChannel: "telegram",
      externalUserId: "user-1",
    });

    expect(ipcCalls).toHaveLength(1);
  });
});

describe("blockSenderChannel gateway-first relay", () => {
  beforeEach(() => {
    ipcCalls = [];
    ipcThrows = false;
    createContactChannelId = "gw-ch1";
    revokeOk = true;
  });

  test("ensures a contact row exists, then revokes the gateway channel", async () => {
    const result = await blockSenderChannel({
      sourceChannel: "slack",
      externalUserId: "U-BLOCKED",
      displayName: "Mallory",
      reason: "introduction_block",
    });

    expect(result.revoked).toBe(true);
    expect(ipcCalls.map((c) => c.method)).toEqual([
      "create_contact",
      "mark_channel_revoked",
    ]);
    expect(ipcCalls[0]!.params).toEqual({
      channelType: "slack",
      address: "U-BLOCKED",
      displayName: "Mallory",
    });
    expect(ipcCalls[1]!.params).toEqual({
      contactChannelId: "gw-ch1",
      reason: "introduction_block",
    });
  });

  test("fails closed when the gateway returns no channel id", async () => {
    createContactChannelId = "";

    const result = await blockSenderChannel({
      sourceChannel: "slack",
      externalUserId: "U-BLOCKED",
    });

    expect(result.revoked).toBe(false);
    // The revoke must not be attempted against an unknown channel.
    expect(ipcCalls.map((c) => c.method)).toEqual(["create_contact"]);
  });

  test("fails closed when the gateway relay throws", async () => {
    ipcThrows = true;

    const result = await blockSenderChannel({
      sourceChannel: "slack",
      externalUserId: "U-BLOCKED",
    });

    expect(result.revoked).toBe(false);
  });

  test("fails closed when the revoke is refused", async () => {
    revokeOk = false;

    const result = await blockSenderChannel({
      sourceChannel: "slack",
      externalUserId: "U-BLOCKED",
    });

    expect(result.revoked).toBe(false);
  });
});

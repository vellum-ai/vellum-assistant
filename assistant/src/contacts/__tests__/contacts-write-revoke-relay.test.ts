/**
 * Tests for the gateway-first member-revoke relay.
 *
 * revokeMemberChannel downgrades the channel's ACL status through the gateway
 * (source of truth) via `ipcCallPersistent("mark_channel_revoked", ...)` first,
 * then mirrors the downgrade to the assistant DB best-effort. A local mirror
 * failure is swallowed so the gateway-owned outcome stands.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ContactWriteResult } from "../types.js";

type IpcCall = { method: string; params?: Record<string, unknown> };

let ipcCalls: IpcCall[] = [];
let ipcOk = true;

const ipcCallPersistentMock = mock(
  async (method: string, params?: Record<string, unknown>) => {
    ipcCalls.push({ method, params });
    return {
      ok: ipcOk,
      didWrite: ipcOk,
      channel: {
        id: (params?.contactChannelId as string) ?? "ch1",
        contactId: "c1",
        type: "telegram",
        address: "addr",
        status: "revoked",
        revokedReason: (params?.reason as string) ?? null,
      },
    };
  },
);
const actualGatewayClient = await import("../../ipc/gateway-client.js");
mock.module("../../ipc/gateway-client.js", () => ({
  ...actualGatewayClient,
  ipcCallPersistent: ipcCallPersistentMock,
}));

// Local channel lookup gating the redundant-revoke skip.
let localChannelStatus: string | null = "active";
const actualContactStore = await import("../contact-store.js");
mock.module("../contact-store.js", () => ({
  ...actualContactStore,
  getChannelById: mock((id: string) =>
    localChannelStatus
      ? { id, contactId: "c1", type: "telegram", status: localChannelStatus }
      : null,
  ),
}));

// Local-mirror primitive.
const revokeMemberResult: ContactWriteResult = {
  contact: { id: "c1" } as ContactWriteResult["contact"],
  channel: { id: "ch1", status: "revoked" } as ContactWriteResult["channel"],
};
const revokeMemberMock = mock((_memberId: string, _reason?: string) =>
  revokeMemberResult,
);
const actualContactsWrite = await import("../contacts-write.js");
mock.module("../contacts-write.js", () => ({
  ...actualContactsWrite,
  revokeMember: revokeMemberMock,
}));

const { revokeMemberChannel } = await import("../member-write-relay.js");

describe("revokeMemberChannel gateway-first relay", () => {
  beforeEach(() => {
    ipcCalls = [];
    ipcOk = true;
    localChannelStatus = "active";
    ipcCallPersistentMock.mockClear();
    revokeMemberMock.mockClear();
    revokeMemberMock.mockImplementation(() => revokeMemberResult);
  });

  test("relays the revoke to the gateway before mirroring locally", async () => {
    const result = await revokeMemberChannel("ch1", "removed");

    expect(ipcCalls).toEqual([
      {
        method: "mark_channel_revoked",
        params: { contactChannelId: "ch1", reason: "removed" },
      },
    ]);
    expect(revokeMemberMock).toHaveBeenCalledTimes(1);
    expect(revokeMemberMock).toHaveBeenCalledWith("ch1", "removed");
    expect(result).toBe(revokeMemberResult);
  });

  test("strips the composite contactId:channelId prefix before the relay", async () => {
    await revokeMemberChannel("c1:ch1");

    expect(ipcCalls[0]?.params?.contactChannelId).toBe("ch1");
    // The local mirror still receives the original composite id it accepts.
    expect(revokeMemberMock).toHaveBeenCalledWith("c1:ch1", undefined);
  });

  test("skips the relay when the gateway channel is already revoked", async () => {
    localChannelStatus = "revoked";

    const result = await revokeMemberChannel("ch1");

    expect(ipcCalls).toEqual([]);
    expect(revokeMemberMock).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  test("swallows a local-mirror failure without throwing; the gateway revoke stands", async () => {
    revokeMemberMock.mockImplementation(() => {
      throw new Error("local mirror exploded");
    });

    const result = await revokeMemberChannel("ch1", "removed");

    expect(ipcCalls).toHaveLength(1);
    expect(result).toBeNull();
  });

  test("throws when the gateway relay returns ok: false", async () => {
    ipcOk = false;

    let thrown: Error | undefined;
    try {
      await revokeMemberChannel("ch1");
    } catch (err) {
      thrown = err as Error;
    }

    expect(thrown).toBeDefined();
    // Local mirror must not run when the gateway refuses the downgrade.
    expect(revokeMemberMock).not.toHaveBeenCalled();
  });
});

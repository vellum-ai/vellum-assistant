/**
 * Tests for the gateway-backed invite client.
 *
 * The IPC transport is stubbed; each wrapper is exercised for wire-method +
 * param mapping, contract-schema validation of responses, malformed-response
 * rejection, and unchanged propagation of transport errors (fail-closed —
 * an `IpcCallError` keeps its gateway statusCode for the relay routes).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { INVITES_IPC_METHODS } from "@vellumai/gateway-client";
import { IpcCallError } from "@vellumai/gateway-client/ipc-client";

type IpcCall = { method: string; params?: Record<string, unknown> };

let ipcCalls: IpcCall[] = [];
let ipcResponse: unknown;
let ipcError: Error | null = null;

const ipcCallPersistentMock = mock(
  async (method: string, params?: Record<string, unknown>) => {
    ipcCalls.push({ method, params });
    if (ipcError) {
      throw ipcError;
    }
    return ipcResponse;
  },
);
const actualGatewayClient = await import("../../ipc/gateway-client.js");
mock.module("../../ipc/gateway-client.js", () => ({
  ...actualGatewayClient,
  ipcCallPersistent: ipcCallPersistentMock,
}));

const client = await import("../gateway-invites.js");

const inviteRow = {
  id: "inv-1",
  sourceChannel: "telegram",
  status: "active",
  maxUses: 1,
  useCount: 0,
};

beforeEach(() => {
  ipcCalls = [];
  ipcResponse = undefined;
  ipcError = null;
});

describe("listInvites", () => {
  test("relays invites_list with only the provided filters", async () => {
    ipcResponse = { invites: [inviteRow] };

    const invites = await client.listInvites({
      sourceChannel: "telegram",
      status: "active",
    });

    expect(ipcCalls).toEqual([
      {
        method: INVITES_IPC_METHODS.list,
        params: { sourceChannel: "telegram", status: "active" },
      },
    ]);
    expect(invites).toEqual([inviteRow]);
  });

  test("sends empty params when no filters are given", async () => {
    ipcResponse = { invites: [] };

    await client.listInvites();

    expect(ipcCalls).toEqual([
      { method: INVITES_IPC_METHODS.list, params: {} },
    ]);
  });

  test("rejects a malformed response", async () => {
    ipcResponse = { invites: [{ sourceChannel: "telegram" }] };

    await expect(client.listInvites()).rejects.toThrow(
      "malformed invites_list response",
    );
  });
});

describe("createInvite", () => {
  test("relays invites_create and returns the one-time payload", async () => {
    ipcResponse = {
      invite: { ...inviteRow, token: "raw-tok" },
      rawToken: "raw-tok",
    };

    const result = await client.createInvite({
      contactId: "c1",
      sourceChannel: "telegram",
      note: "hi",
      maxUses: 2,
    });

    expect(ipcCalls).toEqual([
      {
        method: INVITES_IPC_METHODS.create,
        params: {
          contactId: "c1",
          sourceChannel: "telegram",
          note: "hi",
          maxUses: 2,
        },
      },
    ]);
    expect(result).toEqual({
      invite: { ...inviteRow, token: "raw-tok" },
      rawToken: "raw-tok",
    });
  });

  test("tolerates an absent rawToken (voice invites)", async () => {
    ipcResponse = { invite: { ...inviteRow, sourceChannel: "phone" } };

    const result = await client.createInvite({
      contactId: "c1",
      sourceChannel: "phone",
    });

    expect(result.rawToken).toBeUndefined();
  });

  test("rejects a malformed response", async () => {
    ipcResponse = { invite: { id: "inv-1" } };

    await expect(
      client.createInvite({ contactId: "c1", sourceChannel: "telegram" }),
    ).rejects.toThrow("malformed invites_create response");
  });
});

describe("revokeInvite", () => {
  test("relays invites_revoke and returns the sanitized row", async () => {
    ipcResponse = { invite: { ...inviteRow, status: "revoked" } };

    const invite = await client.revokeInvite("inv-1");

    expect(ipcCalls).toEqual([
      { method: INVITES_IPC_METHODS.revoke, params: { id: "inv-1" } },
    ]);
    expect(invite).toEqual({ ...inviteRow, status: "revoked" });
  });

  test("rejects a malformed response", async () => {
    ipcResponse = { ok: true };

    await expect(client.revokeInvite("inv-1")).rejects.toThrow(
      "malformed invites_revoke response",
    );
  });
});

describe("redeemInviteByToken", () => {
  test("relays the token branch and returns the parsed payload", async () => {
    ipcResponse = {
      ok: true,
      invite: { ...inviteRow, status: "redeemed" },
      type: "redeemed",
    };

    const result = await client.redeemInviteByToken({
      token: "raw-tok",
      sourceChannel: "telegram",
      externalUserId: "u1",
      displayName: "Alice",
    });

    expect(ipcCalls).toEqual([
      {
        method: INVITES_IPC_METHODS.redeem,
        params: {
          token: "raw-tok",
          sourceChannel: "telegram",
          externalUserId: "u1",
          displayName: "Alice",
        },
      },
    ]);
    expect(result.type).toBe("redeemed");
  });

  test("rejects a response with an off-contract type", async () => {
    ipcResponse = { ok: true, invite: inviteRow, type: "maybe" };

    await expect(
      client.redeemInviteByToken({ token: "t", sourceChannel: "telegram" }),
    ).rejects.toThrow("malformed invites_redeem response");
  });
});

describe("redeemInviteByVoiceCode", () => {
  test("relays the voice branch with the assistantId passthrough", async () => {
    ipcResponse = {
      ok: true,
      type: "already_member",
      memberId: "ct-1",
    };

    const result = await client.redeemInviteByVoiceCode({
      callerExternalUserId: "+15555550100",
      code: "123456",
      assistantId: "asst-1",
    });

    expect(ipcCalls).toEqual([
      {
        method: INVITES_IPC_METHODS.redeem,
        params: {
          callerExternalUserId: "+15555550100",
          code: "123456",
          assistantId: "asst-1",
        },
      },
    ]);
    expect(result).toEqual({
      ok: true,
      type: "already_member",
      memberId: "ct-1",
    });
  });

  test("rejects a malformed response", async () => {
    ipcResponse = { ok: true };

    await expect(
      client.redeemInviteByVoiceCode({
        callerExternalUserId: "+15555550100",
        code: "123456",
      }),
    ).rejects.toThrow("malformed invites_redeem response");
  });
});

describe("transport failures", () => {
  test("an IpcCallError propagates unchanged (statusCode preserved)", async () => {
    ipcError = new IpcCallError("Invite not found", {
      statusCode: 404,
      errorCode: "NOT_FOUND",
    });

    try {
      await client.revokeInvite("missing");
      throw new Error("expected revokeInvite to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(IpcCallError);
      expect((err as IpcCallError).statusCode).toBe(404);
    }
  });
});

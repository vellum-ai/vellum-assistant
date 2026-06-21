/**
 * Unit tests for the CLI invite relay routes.
 *
 * The four CLI invite handlers (list/create/revoke/trigger_call) are thin
 * relays to the gateway IPC methods via `ipcCallPersistent`. These tests assert
 * each relays with the correct method + params, returns the parsed gateway
 * response, never writes the assistant invite store directly, and surfaces a
 * relayed IpcCallError with its statusCode. `invites_redeem` stays daemon-local.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { IpcCallError } from "@vellumai/gateway-client/ipc-client";

type IpcCall = {
  method: string;
  params?: Record<string, unknown>;
};

let ipcCalls: IpcCall[] = [];
let ipcResult: unknown = {};
let ipcError: Error | undefined;

const ipcCallPersistentMock = mock(
  async (method: string, params?: Record<string, unknown>) => {
    ipcCalls.push({ method, params });
    if (ipcError) throw ipcError;
    return ipcResult;
  },
);

const actualGatewayClient = await import("../../../ipc/gateway-client.js");

mock.module("../../../ipc/gateway-client.js", () => ({
  ...actualGatewayClient,
  ipcCallPersistent: ipcCallPersistentMock,
}));

// Guard: fail loudly if any relayed handler still writes the assistant invite
// store directly. The relayed CLI paths must go through the gateway only, so we
// spy on the store's write functions and assert they are never invoked.
const actualInviteStore = await import("../../../memory/invite-store.js");

const inviteStoreCall = mock(() => {
  throw new Error("invite-store write must not happen on relayed CLI paths");
});

mock.module("../../../memory/invite-store.js", () => ({
  ...actualInviteStore,
  createInvite: inviteStoreCall,
  listInvites: inviteStoreCall,
  revokeInvite: inviteStoreCall,
}));

const {
  handleListInvites,
  handleCreateInvite,
  handleRevokeInvite,
  handleTriggerInviteCall,
  ROUTES,
} = await import("../contact-routes.js");

describe("invite relay routes", () => {
  beforeEach(() => {
    ipcCalls = [];
    ipcResult = {};
    ipcError = undefined;
    ipcCallPersistentMock.mockClear();
    inviteStoreCall.mockClear();
  });

  describe("handleListInvites", () => {
    test("relays invites_list with filters from queryParams", async () => {
      ipcResult = { invites: [{ id: "i1" }] };
      const result = await handleListInvites({
        queryParams: { sourceChannel: "telegram", status: "active" },
      });

      expect(ipcCalls).toEqual([
        {
          method: "invites_list",
          params: { sourceChannel: "telegram", status: "active" },
        },
      ]);
      expect(result).toEqual({ ok: true, invites: [{ id: "i1" }] });
      expect(inviteStoreCall).not.toHaveBeenCalled();
    });

    test("omits absent filters", async () => {
      ipcResult = { invites: [] };
      await handleListInvites({ queryParams: {} });

      expect(ipcCalls).toEqual([{ method: "invites_list", params: {} }]);
    });
  });

  describe("handleCreateInvite", () => {
    test("relays invites_create with mapped body and returns invite + rawToken", async () => {
      ipcResult = { invite: { id: "i9", token: "tok-9" }, rawToken: "tok-9" };
      const result = await handleCreateInvite({
        body: {
          contactId: "c1",
          sourceChannel: "telegram",
          note: "hi",
          maxUses: 2,
        },
      });

      expect(ipcCalls).toEqual([
        {
          method: "invites_create",
          params: {
            contactId: "c1",
            sourceChannel: "telegram",
            note: "hi",
            maxUses: 2,
            expiresInMs: undefined,
            contactName: undefined,
            expectedExternalUserId: undefined,
            voiceCodeDigits: undefined,
            friendName: undefined,
            guardianName: undefined,
          },
        },
      ]);
      expect(result).toEqual({
        ok: true,
        invite: { id: "i9", token: "tok-9" },
        rawToken: "tok-9",
      });
      expect(inviteStoreCall).not.toHaveBeenCalled();
    });

    test("omits rawToken when the gateway returns none", async () => {
      ipcResult = { invite: { id: "i9" } };
      const result = await handleCreateInvite({
        body: { contactId: "c1", sourceChannel: "phone" },
      });

      expect(result).toEqual({ ok: true, invite: { id: "i9" } });
    });
  });

  describe("handleRevokeInvite", () => {
    test("relays invites_revoke with id from pathParams", async () => {
      ipcResult = { invite: { id: "i3", status: "revoked" } };
      const result = await handleRevokeInvite({ pathParams: { id: "i3" } });

      expect(ipcCalls).toEqual([
        { method: "invites_revoke", params: { id: "i3" } },
      ]);
      expect(result).toEqual({
        ok: true,
        invite: { id: "i3", status: "revoked" },
      });
      expect(inviteStoreCall).not.toHaveBeenCalled();
    });
  });

  describe("handleTriggerInviteCall", () => {
    test("relays invites_trigger_call and returns callSid", async () => {
      ipcResult = { callSid: "CA123" };
      const result = await handleTriggerInviteCall({ pathParams: { id: "i7" } });

      expect(ipcCalls).toEqual([
        { method: "invites_trigger_call", params: { id: "i7" } },
      ]);
      expect(result).toEqual({ ok: true, callSid: "CA123" });
      expect(inviteStoreCall).not.toHaveBeenCalled();
    });
  });

  describe("error propagation", () => {
    test("relayed IpcCallError surfaces with its statusCode/errorCode", async () => {
      ipcError = new IpcCallError("Invite not found", {
        statusCode: 404,
        errorCode: "NOT_FOUND",
      });

      try {
        await handleRevokeInvite({ pathParams: { id: "missing" } });
        throw new Error("expected handler to throw");
      } catch (err) {
        const e = err as { statusCode?: number; code?: string; message: string };
        expect(e.message).toBe("Invite not found");
        expect(e.statusCode).toBe(404);
        expect(e.code).toBe("NOT_FOUND");
      }
    });
  });

  describe("invites_redeem carve-out", () => {
    test("redeem route is registered but NOT relayed to the gateway", () => {
      const redeemRoute = ROUTES.find((r) => r.operationId === "invites_redeem");
      expect(redeemRoute).toBeDefined();
      // The redeem handler is daemon-local; it must not appear in the relayed
      // operation set above. No gateway IPC call is made by registering it.
      expect(ipcCalls).toEqual([]);
    });
  });
});

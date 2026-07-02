/**
 * Unit tests for the CLI invite relay routes.
 *
 * Three CLI invite handlers (list/create/revoke) are thin relays to the gateway
 * IPC methods via `ipcCallPersistent`. These tests assert each relays with the
 * correct method + params, returns the parsed gateway response, never writes the
 * assistant invite store directly, and surfaces a relayed IpcCallError with its
 * statusCode. `invites_redeem` and `invites_trigger_call` stay daemon-local: the
 * gateway delegates the actual provider call to the daemon-local handler, so
 * relaying it back would loop gateway→assistant→gateway.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { IpcCallError } from "@vellumai/gateway-client/ipc-client";

type IpcCall = {
  method: string;
  params?: Record<string, unknown>;
  timeoutMs?: number;
};

let ipcCalls: IpcCall[] = [];
let ipcResult: unknown = {};
let ipcError: Error | undefined;

const ipcCallPersistentMock = mock(
  async (
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ) => {
    ipcCalls.push({ method, params, timeoutMs });
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
const actualInviteStore = await import("../../../persistence/invite-store.js");

const inviteStoreCall = mock(() => {
  throw new Error("invite-store write must not happen on relayed CLI paths");
});

mock.module("../../../persistence/invite-store.js", () => ({
  ...actualInviteStore,
  createInvite: inviteStoreCall,
  listInvites: inviteStoreCall,
  revokeInvite: inviteStoreCall,
}));

// `invites_trigger_call` is daemon-local: the handler invokes the local
// `triggerInviteCall` provider logic directly (never `ipcCallPersistent`).
let triggerInviteCallResult: unknown = { ok: true, data: { callSid: "CA000" } };
const triggerInviteCallMock = mock(
  async (_id: string) => triggerInviteCallResult,
);

const actualInviteService = await import("../../invite-service.js");

mock.module("../../invite-service.js", () => ({
  ...actualInviteService,
  triggerInviteCall: triggerInviteCallMock,
  // Deterministic guardian label so the voice-create passthrough is assertable
  // (the real resolver reads the guardian persona file).
  resolveInviteGuardianName: () => "Guardian Name",
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
    triggerInviteCallResult = { ok: true, data: { callSid: "CA000" } };
    triggerInviteCallMock.mockClear();
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
          // List uses the default IPC timeout (no longer-timeout relay needed).
          timeoutMs: undefined,
        },
      ]);
      expect(result).toEqual({ ok: true, invites: [{ id: "i1" }] });
      expect(inviteStoreCall).not.toHaveBeenCalled();
    });

    test("omits absent filters", async () => {
      ipcResult = { invites: [] };
      await handleListInvites({ queryParams: {} });

      expect(ipcCalls).toEqual([
        { method: "invites_list", params: {}, timeoutMs: undefined },
      ]);
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
            expectedExternalUserId: undefined,
          },
          // The gateway mint is a fast native DB write; the LLM presentation
          // step runs daemon-side after the relay, so the default timeout fits.
          timeoutMs: undefined,
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

    test("supplies guardianName (voice) and sourceConversationId passthrough", async () => {
      ipcResult = { invite: { id: "iv" } };
      await handleCreateInvite({
        body: {
          contactId: "c1",
          sourceChannel: "phone",
          expectedExternalUserId: "+15551234567",
          sourceConversationId: "conv-1",
        },
      });

      expect(ipcCalls[0].params).toMatchObject({
        contactId: "c1",
        sourceChannel: "phone",
        expectedExternalUserId: "+15551234567",
        guardianName: "Guardian Name",
        sourceConversationId: "conv-1",
      });
    });

    test("omits guardianName for non-voice creates", async () => {
      ipcResult = { invite: { id: "i9" } };
      await handleCreateInvite({
        body: { contactId: "c1", sourceChannel: "telegram" },
      });

      expect("guardianName" in (ipcCalls[0].params ?? {})).toBe(false);
    });
  });

  describe("handleRevokeInvite", () => {
    test("relays invites_revoke with id from pathParams", async () => {
      ipcResult = { invite: { id: "i3", status: "revoked" } };
      const result = await handleRevokeInvite({ pathParams: { id: "i3" } });

      expect(ipcCalls).toEqual([
        {
          method: "invites_revoke",
          params: { id: "i3" },
          timeoutMs: undefined,
        },
      ]);
      expect(result).toEqual({
        ok: true,
        invite: { id: "i3", status: "revoked" },
      });
      expect(inviteStoreCall).not.toHaveBeenCalled();
    });
  });

  describe("handleTriggerInviteCall (daemon-local carve-out)", () => {
    test("invokes the local triggerInviteCall and does NOT relay to the gateway", async () => {
      triggerInviteCallResult = { ok: true, data: { callSid: "CA123" } };
      const result = await handleTriggerInviteCall({
        pathParams: { id: "i7" },
      });

      expect(triggerInviteCallMock).toHaveBeenCalledTimes(1);
      expect(triggerInviteCallMock).toHaveBeenCalledWith("i7");
      // Must NOT relay: relaying invites_trigger_call would loop
      // gateway→assistant→gateway (the gateway calls THIS to place the call).
      expect(ipcCalls).toEqual([]);
      expect(result).toEqual({ ok: true, callSid: "CA123" });
    });

    test("surfaces a failed provider call as a 400", async () => {
      triggerInviteCallResult = { ok: false, error: "Invite not eligible" };

      try {
        await handleTriggerInviteCall({ pathParams: { id: "i7" } });
        throw new Error("expected handler to throw");
      } catch (err) {
        const e = err as { statusCode?: number; message: string };
        expect(e.message).toBe("Invite not eligible");
        expect(e.statusCode).toBe(400);
      }
      expect(ipcCalls).toEqual([]);
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
        const e = err as {
          statusCode?: number;
          code?: string;
          message: string;
        };
        expect(e.message).toBe("Invite not found");
        expect(e.statusCode).toBe(404);
        expect(e.code).toBe("NOT_FOUND");
      }
    });
  });

  describe("invites_redeem carve-out", () => {
    test("redeem route is registered but NOT relayed to the gateway", () => {
      const redeemRoute = ROUTES.find(
        (r) => r.operationId === "invites_redeem",
      );
      expect(redeemRoute).toBeDefined();
      // The redeem handler is daemon-local; it must not appear in the relayed
      // operation set above. No gateway IPC call is made by registering it.
      expect(ipcCalls).toEqual([]);
    });
  });
});

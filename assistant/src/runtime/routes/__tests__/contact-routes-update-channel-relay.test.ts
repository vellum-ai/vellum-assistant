/**
 * Unit tests for the daemon updateContactChannel relay.
 *
 * `handleUpdateContactChannelRoute` is a thin relay to the gateway IPC method
 * `update_contact_channel` via `ipcCallPersistent`. The gateway DB is the source
 * of truth: the daemon writes NOTHING to the assistant DB directly. These tests
 * assert the handler forwards `{ contactChannelId, status, policy, reason }`
 * unchanged, returns the gateway response verbatim, never touches the assistant
 * contact store, and propagates an unexpected relay rejection (no fallback).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { IpcCallError } from "@vellumai/gateway-client/ipc-client";

type IpcCall = {
  method: string;
  params?: Record<string, unknown>;
  timeoutMs?: number;
};

let ipcCalls: IpcCall[] = [];
let ipcResult: unknown = { ok: true };
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

// Guard: fail loudly if the relay still writes the assistant contact store
// directly. The relayed update path must go through the gateway only.
const actualContactStore = await import("../../../contacts/contact-store.js");

const contactStoreWriteGuard = mock(() => {
  throw new Error(
    "assistant contact-store write must not happen on the relayed update path",
  );
});

mock.module("../../../contacts/contact-store.js", () => ({
  ...actualContactStore,
  updateChannelStatus: contactStoreWriteGuard,
}));

const { handleUpdateContactChannelRoute, ROUTES } = await import(
  "../contact-routes.js"
);

describe("update contact channel relay", () => {
  beforeEach(() => {
    ipcCalls = [];
    ipcResult = { ok: true };
    ipcError = undefined;
    ipcCallPersistentMock.mockClear();
    contactStoreWriteGuard.mockClear();
  });

  test("forwards { contactChannelId, status, policy, reason } unchanged and returns the gateway response verbatim", async () => {
    const gatewayResponse = {
      ok: true,
      contact: { id: "ct_1", displayName: "Alice", channels: [] },
    };
    ipcResult = gatewayResponse;

    const result = await handleUpdateContactChannelRoute({
      pathParams: { contactChannelId: "ch_1" },
      body: { status: "revoked", policy: "deny", reason: "user request" },
    });

    expect(ipcCalls).toEqual([
      {
        method: "update_contact_channel",
        params: {
          contactChannelId: "ch_1",
          status: "revoked",
          policy: "deny",
          reason: "user request",
        },
        timeoutMs: undefined,
      },
    ]);
    expect(result).toEqual(gatewayResponse);
    // Must NOT write the assistant DB directly.
    expect(contactStoreWriteGuard).not.toHaveBeenCalled();
  });

  test("omits absent body fields from the relayed params", async () => {
    ipcResult = { ok: true };

    await handleUpdateContactChannelRoute({
      pathParams: { contactChannelId: "ch_2" },
      body: { status: "active" },
    });

    expect(ipcCalls).toEqual([
      {
        method: "update_contact_channel",
        params: { contactChannelId: "ch_2", status: "active" },
        timeoutMs: undefined,
      },
    ]);
    expect(contactStoreWriteGuard).not.toHaveBeenCalled();
  });

  test("relayed IpcCallError surfaces with its statusCode/errorCode", async () => {
    ipcError = new IpcCallError("Channel not found", {
      statusCode: 404,
      errorCode: "NOT_FOUND",
    });

    try {
      await handleUpdateContactChannelRoute({
        pathParams: { contactChannelId: "missing" },
        body: { status: "active" },
      });
      throw new Error("expected handler to throw");
    } catch (err) {
      const e = err as { statusCode?: number; code?: string; message: string };
      expect(e.message).toBe("Channel not found");
      expect(e.statusCode).toBe(404);
      expect(e.code).toBe("NOT_FOUND");
    }
    expect(contactStoreWriteGuard).not.toHaveBeenCalled();
  });

  test("an unexpected relay rejection propagates (no fallback, no second write)", async () => {
    ipcError = new Error("ipc transport exploded");

    try {
      await handleUpdateContactChannelRoute({
        pathParams: { contactChannelId: "ch_3" },
        body: { status: "active" },
      });
      throw new Error("expected handler to throw");
    } catch (err) {
      expect((err as Error).message).toBe("ipc transport exploded");
    }
    // No daemon-side fallback write.
    expect(contactStoreWriteGuard).not.toHaveBeenCalled();
    expect(ipcCalls).toHaveLength(1);
  });

  test("the updateContactChannel route is registered and wired to the relay", () => {
    const route = ROUTES.find((r) => r.operationId === "updateContactChannel");
    expect(route).toBeDefined();
    expect(route?.endpoint).toBe("contact-channels/:contactChannelId");
    expect(route?.method).toBe("PATCH");
  });
});

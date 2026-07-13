/**
 * Unit tests for the daemon merge_contacts relay.
 *
 * `handleMergeContactsRoute` is a thin relay to the gateway IPC method
 * `merge_contacts` via `ipcCallPersistent`. The gateway DB is the source of
 * truth: it owns validation, the merge transaction, and the assistant-DB
 * mirror — the daemon writes NOTHING to the assistant DB directly. These tests
 * assert the handler forwards `{ keepId, mergeId }` unchanged, returns the
 * gateway response verbatim, never touches the assistant contact store, and
 * propagates a relay failure (no local-merge fallback).
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
    if (ipcError) {
      throw ipcError;
    }
    return ipcResult;
  },
);

const actualGatewayClient = await import("../../../ipc/gateway-client.js");

mock.module("../../../ipc/gateway-client.js", () => ({
  ...actualGatewayClient,
  ipcCallPersistent: ipcCallPersistentMock,
}));

// Guard: fail loudly if the relay still writes the assistant contact store
// directly. The assistant DB only changes via the gateway's
// `contacts_mirror_merge_contact` mirror op, never on this route.
const actualContactStore = await import("../../../contacts/contact-store.js");

const contactStoreWriteGuard = mock(() => {
  throw new Error(
    "assistant contact-store write must not happen on the relayed merge path",
  );
});

mock.module("../../../contacts/contact-store.js", () => ({
  ...actualContactStore,
  mergeContactMirror: contactStoreWriteGuard,
}));

const { handleMergeContactsRoute, ROUTES } =
  await import("../contact-routes.js");

describe("merge contacts relay", () => {
  beforeEach(() => {
    ipcCalls = [];
    ipcResult = { ok: true };
    ipcError = undefined;
    ipcCallPersistentMock.mockClear();
    contactStoreWriteGuard.mockClear();
  });

  test("forwards { keepId, mergeId } unchanged and returns the gateway response verbatim", async () => {
    const gatewayResponse = {
      ok: true as const,
      contact: { id: "ct_keep", displayName: "Alice", channels: [] },
    };
    ipcResult = gatewayResponse;

    const result = await handleMergeContactsRoute({
      body: { keepId: "ct_keep", mergeId: "ct_merge" },
    });

    expect(ipcCalls).toEqual([
      {
        method: "merge_contacts",
        params: { keepId: "ct_keep", mergeId: "ct_merge" },
        timeoutMs: undefined,
      },
    ]);
    expect(result).toEqual(gatewayResponse);
    // Must NOT write the assistant DB directly.
    expect(contactStoreWriteGuard).not.toHaveBeenCalled();
  });

  test("missing keepId/mergeId is rejected before any relay call", async () => {
    for (const body of [
      {},
      { keepId: "ct_keep" },
      { mergeId: "ct_merge" },
      { keepId: "", mergeId: "ct_merge" },
    ]) {
      try {
        await handleMergeContactsRoute({ body });
        throw new Error("expected handler to throw");
      } catch (err) {
        const e = err as { statusCode?: number; message: string };
        expect(e.message).toBe("keepId and mergeId are required");
        expect(e.statusCode).toBe(400);
      }
    }
    expect(ipcCalls).toHaveLength(0);
    expect(contactStoreWriteGuard).not.toHaveBeenCalled();
  });

  test("relayed IpcCallError surfaces with its statusCode/errorCode", async () => {
    ipcError = new IpcCallError("Cannot merge a contact with itself", {
      statusCode: 400,
      errorCode: "MERGE_CONTACTS_INVALID",
    });

    try {
      await handleMergeContactsRoute({
        body: { keepId: "ct_same", mergeId: "ct_same" },
      });
      throw new Error("expected handler to throw");
    } catch (err) {
      const e = err as { statusCode?: number; code?: string; message: string };
      expect(e.message).toBe("Cannot merge a contact with itself");
      expect(e.statusCode).toBe(400);
      expect(e.code).toBe("MERGE_CONTACTS_INVALID");
    }
    expect(contactStoreWriteGuard).not.toHaveBeenCalled();
  });

  test("gateway unreachable: the rejection propagates and the assistant DB is untouched (no local merge)", async () => {
    ipcError = new Error("ipc transport exploded");

    try {
      await handleMergeContactsRoute({
        body: { keepId: "ct_keep", mergeId: "ct_merge" },
      });
      throw new Error("expected handler to throw");
    } catch (err) {
      expect((err as Error).message).toBe("ipc transport exploded");
    }
    // No daemon-side fallback write.
    expect(contactStoreWriteGuard).not.toHaveBeenCalled();
    expect(ipcCalls).toHaveLength(1);
  });

  test("the merge_contacts route is registered and wired to the relay", () => {
    const route = ROUTES.find((r) => r.operationId === "merge_contacts");
    expect(route).toBeDefined();
    expect(route?.endpoint).toBe("contacts/merge");
    expect(route?.method).toBe("POST");
  });
});

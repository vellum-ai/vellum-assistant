/**
 * Unit tests for the daemon guardian-contact reader.
 *
 * `getGuardianContactIds` relays to the gateway IPC method
 * `get_guardian_contact` via `ipcCallPersistent`, caches the result with a
 * short TTL, and FAIL-SOFTS to an empty set (no throw) on IPC error.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

let ipcResult: unknown = { ok: true, guardianIds: [] };
let ipcError: Error | undefined;

const ipcCallPersistentMock = mock(async () => {
  if (ipcError) throw ipcError;
  return ipcResult;
});

const actualGatewayClient = await import("../../ipc/gateway-client.js");

mock.module("../../ipc/gateway-client.js", () => ({
  ...actualGatewayClient,
  ipcCallPersistent: ipcCallPersistentMock,
}));

const { getGuardianContactIds, invalidateGuardianContactCache } =
  await import("../guardian-contact-reader.js");

beforeEach(() => {
  ipcCallPersistentMock.mockClear();
  ipcError = undefined;
  ipcResult = { ok: true, guardianIds: [] };
  // Clear any cache carried over from a prior test.
  invalidateGuardianContactCache();
});

describe("getGuardianContactIds", () => {
  test("returns the guardian id set from the gateway IPC", async () => {
    ipcResult = { ok: true, guardianIds: ["g1"] };

    const ids = await getGuardianContactIds();

    expect([...ids]).toEqual(["g1"]);
    expect(ipcCallPersistentMock).toHaveBeenCalledWith(
      "get_guardian_contact",
      {},
    );
  });

  test("caches within the TTL (second call does not re-invoke the IPC)", async () => {
    ipcResult = { ok: true, guardianIds: ["g1"] };

    const first = await getGuardianContactIds();
    const second = await getGuardianContactIds();

    expect([...first]).toEqual(["g1"]);
    expect([...second]).toEqual(["g1"]);
    expect(ipcCallPersistentMock).toHaveBeenCalledTimes(1);
  });

  test("fail-softs to an empty set on IPC error (no throw)", async () => {
    ipcError = new Error("gateway down");

    const ids = await getGuardianContactIds();

    expect([...ids]).toEqual([]);
  });

  test("does not cache a failed read (retries on the next call)", async () => {
    ipcError = new Error("gateway down");
    await getGuardianContactIds();

    ipcError = undefined;
    ipcResult = { ok: true, guardianIds: ["g1"] };
    const ids = await getGuardianContactIds();

    expect([...ids]).toEqual(["g1"]);
    expect(ipcCallPersistentMock).toHaveBeenCalledTimes(2);
  });

  test("invalidating the cache forces a re-fetch", async () => {
    ipcResult = { ok: true, guardianIds: ["g1"] };
    await getGuardianContactIds();
    invalidateGuardianContactCache();
    await getGuardianContactIds();

    expect(ipcCallPersistentMock).toHaveBeenCalledTimes(2);
  });
});

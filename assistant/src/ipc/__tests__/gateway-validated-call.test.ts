/**
 * Tests for ipcCallPersistentValidated connect-failure mapping.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { IpcCallError } from "@vellumai/gateway-client/ipc-client";
import { z } from "zod";

import { ServiceUnavailableError } from "../../runtime/routes/errors.js";

let ipcError: Error | undefined;
let ipcResult: unknown = { ok: true };

const ipcCallPersistentMock = mock(async () => {
  if (ipcError) {
    throw ipcError;
  }
  return ipcResult;
});

mock.module("../gateway-client.js", () => ({
  ipcCallPersistent: ipcCallPersistentMock,
}));

const { ipcCallPersistentValidated } = await import(
  "../gateway-validated-call.js"
);

const OkSchema = z.object({ ok: z.literal(true) });

describe("ipcCallPersistentValidated", () => {
  beforeEach(() => {
    ipcError = undefined;
    ipcResult = { ok: true };
    ipcCallPersistentMock.mockClear();
  });

  test("returns a schema-valid response", async () => {
    const result = await ipcCallPersistentValidated("ping", {}, OkSchema);
    expect(result).toEqual({ ok: true });
  });

  test("propagates ServiceUnavailableError from ipcCallPersistent", async () => {
    ipcError = new ServiceUnavailableError(
      "Gateway is not reachable over IPC: connect ENOENT",
    );

    await expect(
      ipcCallPersistentValidated("ping", {}, OkSchema),
    ).rejects.toBeInstanceOf(ServiceUnavailableError);
  });

  test("propagates IpcCallError unchanged", async () => {
    ipcError = new IpcCallError("Invite not found", {
      statusCode: 404,
      errorCode: "NOT_FOUND",
    });

    try {
      await ipcCallPersistentValidated("ping", {}, OkSchema);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(IpcCallError);
      expect((err as IpcCallError).statusCode).toBe(404);
    }
  });
});

/**
 * The contact-threshold write is IPC-only: registered on the assistant
 * IPC server by operationId and absent from the shared HTTP route set.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

let lastIpcCall: { method: string; params?: Record<string, unknown> } | null =
  null;
let gatewayResult: unknown = {
  ok: true,
  contactId: "contact-1",
  threshold: "high",
};
const notified: string[] = [];
const invalidated: string[] = [];

mock.module("../../gateway-client.js", () => ({
  ipcCall: async (method: string, params?: Record<string, unknown>) => {
    lastIpcCall = { method, params };
    return gatewayResult;
  },
}));

mock.module("../../../contacts/notify-contacts-changed.js", () => ({
  notifyContactsChanged: () => {
    notified.push("contacts_changed");
  },
}));

mock.module("../../../permissions/gateway-threshold-reader.js", () => ({
  invalidateContactThresholdCache: (contactId: string) => {
    invalidated.push(contactId);
  },
}));

const { CONTACT_THRESHOLD_IPC_METHODS, handleSetContactThreshold } =
  await import("../contact-threshold-ipc-routes.js");
const { ROUTES: contactRoutes } =
  await import("../../../runtime/routes/contact-routes.js");
const {
  BadRequestError,
  InternalError,
  NotFoundError,
} = await import("../../../runtime/routes/errors.js");

describe("set_contact_threshold", () => {
  beforeEach(() => {
    lastIpcCall = null;
    gatewayResult = {
      ok: true,
      contactId: "contact-1",
      threshold: "high",
    };
    notified.length = 0;
    invalidated.length = 0;
  });

  test("is reachable on the IPC surface by operationId", () => {
    expect(typeof CONTACT_THRESHOLD_IPC_METHODS.set_contact_threshold).toBe(
      "function",
    );
  });

  test("is NOT in the shared contact ROUTES array", () => {
    const sharedIds = new Set(contactRoutes.map((r) => r.operationId));
    expect(sharedIds.has("set_contact_threshold")).toBe(false);
  });

  test("relays a ceiling write to the gateway and refreshes caches", async () => {
    const result = await handleSetContactThreshold({
      body: { contactId: "contact-1", threshold: "high" },
    });

    expect(lastIpcCall).toEqual({
      method: "set_contact_threshold",
      params: { contactId: "contact-1", threshold: "high" },
    });
    expect(result).toEqual({
      ok: true,
      contactId: "contact-1",
      threshold: "high",
    });
    expect(invalidated).toEqual(["contact-1"]);
    expect(notified).toEqual(["contacts_changed"]);
  });

  test("relays inherit as a null ceiling", async () => {
    gatewayResult = {
      ok: true,
      contactId: "contact-1",
      threshold: null,
    };

    const result = await handleSetContactThreshold({
      body: { contactId: "contact-1", threshold: null },
    });

    expect(lastIpcCall?.params).toEqual({
      contactId: "contact-1",
      threshold: null,
    });
    expect(result).toEqual({
      ok: true,
      contactId: "contact-1",
      threshold: null,
    });
  });

  test("rejects an invalid threshold", async () => {
    await expect(
      handleSetContactThreshold({
        body: { contactId: "contact-1", threshold: "full" },
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(lastIpcCall).toBeNull();
  });

  test("maps a missing contact to NotFoundError", async () => {
    gatewayResult = { ok: false, error: "not_found" };

    await expect(
      handleSetContactThreshold({
        body: { contactId: "contact-missing", threshold: "high" },
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(invalidated).toEqual([]);
    expect(notified).toEqual([]);
  });

  test("maps a transport failure to InternalError", async () => {
    gatewayResult = undefined;

    await expect(
      handleSetContactThreshold({
        body: { contactId: "contact-1", threshold: "high" },
      }),
    ).rejects.toBeInstanceOf(InternalError);
    expect(invalidated).toEqual([]);
    expect(notified).toEqual([]);
  });
});

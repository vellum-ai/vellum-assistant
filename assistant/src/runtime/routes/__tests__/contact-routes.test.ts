/**
 * Unit tests for the contacts read API.
 *
 * `handleListContacts`, `handleGetContact`, and the `search_contacts`
 * no-filter case relay to the gateway rich read (`contacts_list_rich` /
 * `contacts_get_rich`), which is the source of truth for the ACL fields
 * (`role`/`status`/`policy`/`verifiedAt`/`interactionCount`/`lastInteraction`).
 * These tests assert the serialized response shape is gateway-sourced and
 * unchanged for the web client, that no read path falls back to the assistant
 * DB, and that a relay failure fails closed (surfaces an error) instead of
 * reading local ACL.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { IpcCallError } from "@vellumai/gateway-client/ipc-client";

let ipcCalls: { method: string; params?: Record<string, unknown> }[] = [];
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

// Guard: fail loudly if any read path falls back to the assistant DB for ACL
// fields. The relay read paths must source role/status/stats from the gateway.
const actualContactStore = await import("../../../contacts/contact-store.js");

const contactStoreReadGuard = mock(() => {
  throw new Error(
    "assistant contact-store read must not happen on the gateway relay path",
  );
});

mock.module("../../../contacts/contact-store.js", () => ({
  ...actualContactStore,
  getContact: contactStoreReadGuard,
  listContacts: contactStoreReadGuard,
  getAssistantContactMetadata: contactStoreReadGuard,
}));

const { handleListContacts, handleGetContact, ROUTES } = await import(
  "../contact-routes.js"
);

const gatewayChannel = {
  id: "ch_1",
  contactId: "ct_1",
  type: "sms",
  address: "+15550100",
  isPrimary: true,
  externalUserId: null,
  status: "active",
  policy: "allow",
  verifiedAt: 1700,
  verifiedVia: "invite",
  lastSeenAt: 1800,
  interactionCount: 7,
  lastInteraction: 1900,
  revokedReason: null,
  blockedReason: null,
};

const gatewayContact = {
  id: "ct_1",
  displayName: "Alice",
  role: "member",
  notes: "a note",
  contactType: "human",
  lastInteraction: 1900,
  interactionCount: 7,
  createdAt: 1000,
  updatedAt: 1500,
  channels: [gatewayChannel],
};

describe("contacts read API relays from the gateway", () => {
  beforeEach(() => {
    ipcCalls = [];
    ipcResult = {};
    ipcError = undefined;
    ipcCallPersistentMock.mockClear();
    contactStoreReadGuard.mockClear();
  });

  test("list relays to contacts_list_rich and serializes the gateway ACL fields", async () => {
    ipcResult = { ok: true, contacts: [gatewayContact] };

    const result = await handleListContacts({ limit: "50" });

    expect(ipcCalls).toEqual([
      { method: "contacts_list_rich", params: { limit: 50 } },
    ]);
    expect(result.ok).toBe(true);
    expect(result.contacts).toHaveLength(1);

    const [contact] = result.contacts;
    // ACL fields are gateway-sourced and reach the web client unchanged. `role`
    // is optional on the transform (gateway reads carry it, daemon-native omit).
    expect((contact as { role?: string }).role).toBe("member");
    expect(contact.interactionCount).toBe(7);
    expect(contact.lastInteraction).toBe(1900);
    const channel = contact.channels[0] as Record<string, unknown>;
    expect(channel.status).toBe("active");
    expect(channel.policy).toBe("allow");
    expect(channel.verifiedAt).toBe(1700);
    expect(channel.interactionCount).toBe(7);
    expect(channel.lastInteraction).toBe(1900);
    // Channel compat echoes address into externalUserId for older clients.
    expect(channel.externalUserId).toBe("+15550100");

    expect(contactStoreReadGuard).not.toHaveBeenCalled();
  });

  test("list forwards the role filter to the gateway", async () => {
    ipcResult = { ok: true, contacts: [] };

    await handleListContacts({ limit: "10", role: "guardian" });

    expect(ipcCalls).toEqual([
      {
        method: "contacts_list_rich",
        params: { limit: 10, role: "guardian" },
      },
    ]);
  });

  test("list fails closed when the gateway relay is unavailable", async () => {
    ipcError = new IpcCallError("gateway down", {
      statusCode: 503,
      errorCode: "UNAVAILABLE",
    });

    await expect(handleListContacts({ limit: "50" })).rejects.toMatchObject({
      message: "gateway down",
      statusCode: 503,
    });
    // No assistant-DB fallback read.
    expect(contactStoreReadGuard).not.toHaveBeenCalled();
  });

  test("get relays to contacts_get_rich and serializes the gateway ACL fields", async () => {
    ipcResult = { ok: true, contact: gatewayContact };

    const result = await handleGetContact("ct_1");

    expect(ipcCalls).toEqual([
      { method: "contacts_get_rich", params: { contactId: "ct_1" } },
    ]);
    expect(result.ok).toBe(true);
    expect(result.contact.role).toBe("member");
    expect(result.contact.interactionCount).toBe(7);
    const channel = result.contact.channels[0] as Record<string, unknown>;
    expect(channel.status).toBe("active");
    expect(channel.externalUserId).toBe("+15550100");
    expect(contactStoreReadGuard).not.toHaveBeenCalled();
  });

  test("get surfaces a clean gateway not-found as a 404", async () => {
    ipcResult = { ok: true };

    await expect(handleGetContact("missing")).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(contactStoreReadGuard).not.toHaveBeenCalled();
  });

  test("get fails closed on a relay failure (no assistant-DB fallback)", async () => {
    ipcError = new IpcCallError("gateway down", {
      statusCode: 503,
      errorCode: "UNAVAILABLE",
    });

    await expect(handleGetContact("ct_1")).rejects.toMatchObject({
      message: "gateway down",
      statusCode: 503,
    });
    expect(contactStoreReadGuard).not.toHaveBeenCalled();
  });

  test("search no-filter relays to the gateway list read", async () => {
    ipcResult = { ok: true, contacts: [gatewayContact] };

    const route = ROUTES.find((r) => r.operationId === "search_contacts");
    expect(route).toBeDefined();

    const contacts = (await route!.handler({ body: {} })) as Array<{
      role: string;
      interactionCount: number;
      channels: { status: string }[];
    }>;

    expect(ipcCalls).toEqual([
      { method: "contacts_list_rich", params: { limit: 50 } },
    ]);
    expect(contacts[0].role).toBe("member");
    expect(contacts[0].interactionCount).toBe(7);
    expect(contacts[0].channels[0].status).toBe("active");
    expect(contactStoreReadGuard).not.toHaveBeenCalled();
  });
});

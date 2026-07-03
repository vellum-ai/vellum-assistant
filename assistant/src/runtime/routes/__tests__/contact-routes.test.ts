/**
 * Unit tests for the contacts read API.
 *
 * `handleListContacts`, `handleGetContact`, and the `search_contacts`
 * no-filter case relay to the gateway rich read (`contacts_list_rich` /
 * `contacts_get_rich`), which is the source of truth for the ACL fields
 * (`status`/`policy`/`verifiedAt`/`interactionCount`/`lastInteraction`).
 * Contact-level `role` is derived at the serve layer from the gateway guardian
 * id set (never the local `contacts.role` column). These tests assert the
 * serialized response shape is gateway-sourced and unchanged for the web
 * client, that no read path falls back to the assistant DB, that role + the
 * guardian name override derive from the gateway guardian id set, and that a
 * relay failure fails closed (surfaces an error) instead of reading local ACL.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { IpcCallError } from "@vellumai/gateway-client/ipc-client";
import { z } from "zod";

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

// Filtered/native reads (search) legitimately go to the assistant DB. Drive
// them deterministically so the daemon-native response shape can be asserted.
let searchContactsResult: unknown[] = [];
const searchContactsMock = mock(() => searchContactsResult);

mock.module("../../../contacts/contact-store.js", () => ({
  ...actualContactStore,
  getContact: contactStoreReadGuard,
  listContacts: contactStoreReadGuard,
  getAssistantContactMetadata: contactStoreReadGuard,
  searchContacts: searchContactsMock,
}));

// Role + the guardian name override derive from the gateway guardian id set,
// never the local `contacts.role` column. Drive the set deterministically.
let guardianIds = new Set<string>();
const getGuardianContactIdsMock = mock(async () => guardianIds);

mock.module("../../../contacts/guardian-contact-reader.js", () => ({
  getGuardianContactIds: getGuardianContactIdsMock,
}));

// Make the guardian display-name override observable without a persona file.
const actualUserReference = await import("../../../prompts/user-reference.js");
mock.module("../../../prompts/user-reference.js", () => ({
  ...actualUserReference,
  resolveGuardianName: (name?: string | null) => `guardian:${name}`,
}));

const { handleListContacts, handleGetContact, ROUTES } =
  await import("../contact-routes.js");

// Daemon-native contact: INFO is hydrated locally; channel-level ACL fields
// (status/policy/verification) are gateway-owned and absent on native reads.
// The fixture's `role` is ignored — the serve layer derives role from the
// gateway guardian id set.
const nativeContact = {
  id: "ct_2",
  displayName: "Bob",
  notes: null,
  role: "contact",
  contactType: "human",
  lastInteraction: 4200,
  interactionCount: 4,
  createdAt: 1000,
  updatedAt: 1500,
  userFile: "bob.md",
  channels: [
    {
      id: "ch_2",
      contactId: "ct_2",
      type: "phone",
      address: "+15550200",
      isPrimary: true,
      externalChatId: null,
      lastSeenAt: 4100,
      interactionCount: 4,
      lastInteraction: 4200,
      updatedAt: 1500,
      createdAt: 1000,
    },
  ],
};

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
  role: "guardian",
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
    searchContactsResult = [];
    searchContactsMock.mockClear();
    guardianIds = new Set(["ct_1"]);
    getGuardianContactIdsMock.mockClear();
  });

  test("list relays to contacts_list_rich and trusts the gateway-sourced role", async () => {
    ipcResult = { ok: true, contacts: [gatewayContact] };

    const result = await handleListContacts({ limit: "50" });

    expect(ipcCalls).toEqual([
      { method: "contacts_list_rich", params: { limit: 50 } },
    ]);
    expect(result.ok).toBe(true);
    expect(result.contacts).toHaveLength(1);

    const [contact] = result.contacts;
    // Role comes straight from the relayed payload; the name override keys off
    // that role. The guardian id set is NOT consulted on relayed reads.
    expect((contact as { role?: string }).role).toBe("guardian");
    expect(contact.displayName).toBe("guardian:Alice");
    expect(getGuardianContactIdsMock).not.toHaveBeenCalled();
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

  test("relayed list trusts the gateway role even when the guardian id set is empty/stale", async () => {
    // Reproduces the rebind race: the gateway already returned role "guardian",
    // but the 30s guardian-id cache is empty (or fail-softed). The relayed role
    // must NOT be downgraded to "contact", and the name override must still run.
    ipcResult = { ok: true, contacts: [gatewayContact] };
    guardianIds = new Set();

    const result = await handleListContacts({ limit: "50" });

    const [contact] = result.contacts;
    expect((contact as { role?: string }).role).toBe("guardian");
    expect(contact.displayName).toBe("guardian:Alice");
    // Relayed reads don't consult the guardian id set (they trust the role).
    expect(getGuardianContactIdsMock).not.toHaveBeenCalled();
    expect(contactStoreReadGuard).not.toHaveBeenCalled();
  });

  test("relayed get trusts the gateway role even when the guardian id set is empty/stale", async () => {
    ipcResult = { ok: true, contact: gatewayContact };
    guardianIds = new Set();

    const result = await handleGetContact("ct_1");

    expect(result.contact.role).toBe("guardian");
    expect(result.contact.displayName).toBe("guardian:Alice");
    expect(getGuardianContactIdsMock).not.toHaveBeenCalled();
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
    expect(result.contact.role).toBe("guardian");
    expect(result.contact.displayName).toBe("guardian:Alice");
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
    expect(contacts[0].role).toBe("guardian");
    expect(contacts[0].interactionCount).toBe(7);
    expect(contacts[0].channels[0].status).toBe("active");
    expect(contactStoreReadGuard).not.toHaveBeenCalled();
  });
});

// Gateway rich-read for the native contact (ct_2), with telemetry values
// DISTINCT from the local nativeContact fixture so tests can prove the served
// telemetry is gateway-sourced (hydrated), not the local aggregation.
const nativeGatewayRead = {
  id: "ct_2",
  displayName: "Bob",
  role: "contact",
  notes: null,
  contactType: "human",
  lastInteraction: 9200,
  interactionCount: 11,
  createdAt: 1000,
  updatedAt: 1500,
  channels: [
    {
      id: "ch_2",
      contactId: "ct_2",
      type: "phone",
      address: "+15550200",
      isPrimary: true,
      externalUserId: null,
      status: "active",
      policy: "allow",
      verifiedAt: null,
      verifiedVia: null,
      lastSeenAt: 9100,
      interactionCount: 11,
      lastInteraction: 9200,
      revokedReason: null,
      blockedReason: null,
    },
  ],
};

describe("filtered/native contact reads: daemon filters, gateway hydrates telemetry", () => {
  const listRoute = ROUTES.find((r) => r.operationId === "listContacts")!;
  const listResponseSchema = listRoute.responseBody as z.ZodTypeAny;
  const searchRoute = ROUTES.find((r) => r.operationId === "search_contacts")!;
  const searchResponseSchema = searchRoute.responseBody as z.ZodTypeAny;

  beforeEach(() => {
    ipcCalls = [];
    // Telemetry hydration relays `contacts_list_rich` with an ids filter; return
    // the gateway rich-read for ct_2 by default so hydration succeeds.
    ipcResult = { ok: true, contacts: [nativeGatewayRead] };
    ipcError = undefined;
    ipcCallPersistentMock.mockClear();
    contactStoreReadGuard.mockClear();
    searchContactsResult = [];
    searchContactsMock.mockClear();
    guardianIds = new Set();
    getGuardianContactIdsMock.mockClear();
  });

  test("query-filtered list hydrates telemetry from the gateway (not local aggregation)", async () => {
    searchContactsResult = [nativeContact];

    const result = await handleListContacts({ query: "Bob", limit: "10" });

    // Filtering stays daemon-native; telemetry is hydrated via an ids-scoped
    // gateway rich read.
    expect(searchContactsMock).toHaveBeenCalled();
    expect(ipcCalls).toEqual([
      { method: "contacts_list_rich", params: { ids: ["ct_2"] } },
    ]);

    const [contact] = result.contacts;
    // Telemetry comes from the gateway (11/9200/9100), NOT the local fixture
    // (4/4200/4100).
    expect(contact.interactionCount).toBe(11);
    expect(contact.lastInteraction).toBe(9200);
    const channel = contact.channels[0] as Record<string, unknown>;
    expect(channel.interactionCount).toBe(11);
    expect(channel.lastSeenAt).toBe(9100);
    expect(channel.lastInteraction).toBe(9200);
    expect(channel.externalUserId).toBe("+15550200");
    // Non-guardian id derives role "contact" (no name override).
    expect((contact as { role: string }).role).toBe("contact");
    expect(contact.displayName).toBe("Bob");
    // Channel-level ACL fields (status/policy) are gateway-owned and absent on
    // the daemon-native shape.
    expect("status" in channel).toBe(false);
    expect(() => listResponseSchema.parse(result)).not.toThrow();
  });

  test("telemetry degrades to default (0 counts, null timestamps) when the gateway hydration fails", async () => {
    searchContactsResult = [nativeContact];
    ipcError = new IpcCallError("gateway down", {
      statusCode: 503,
      errorCode: "UNAVAILABLE",
    });

    const result = await handleListContacts({ query: "Bob", limit: "10" });

    // Search results are still returned; the interaction counts default to 0
    // (never null, so callers render a real number) and the timestamps null.
    const [contact] = result.contacts;
    expect(contact.interactionCount).toBe(0);
    expect(contact.lastInteraction).toBeNull();
    const channel = contact.channels[0] as Record<string, unknown>;
    expect(channel.interactionCount).toBe(0);
    expect(channel.lastSeenAt).toBeNull();
    expect(contact.displayName).toBe("Bob");
    expect(() => listResponseSchema.parse(result)).not.toThrow();
  });

  test("daemon-native search stamps role guardian + the name override from the gateway id set", async () => {
    searchContactsResult = [nativeContact];
    guardianIds = new Set(["ct_2"]);

    const result = await handleListContacts({ query: "Bob", limit: "10" });

    expect(searchContactsMock).toHaveBeenCalled();
    const [contact] = result.contacts;
    expect((contact as { role: string }).role).toBe("guardian");
    expect(contact.displayName).toBe("guardian:Bob");
    expect(getGuardianContactIdsMock).toHaveBeenCalled();
  });

  test("fail-soft: an empty guardian id set yields role contact with no override", async () => {
    searchContactsResult = [nativeContact];
    guardianIds = new Set();

    const result = await handleListContacts({ query: "Bob", limit: "10" });

    const [contact] = result.contacts;
    expect((contact as { role: string }).role).toBe("contact");
    expect(contact.displayName).toBe("Bob");
  });

  test("POST search with a filter hydrates telemetry and validates against the response schema", async () => {
    searchContactsResult = [nativeContact];

    const contacts = (await searchRoute.handler({
      body: { query: "Bob" },
    })) as Array<{ interactionCount: number | null }>;

    expect(searchContactsMock).toHaveBeenCalled();
    expect(ipcCalls).toEqual([
      { method: "contacts_list_rich", params: { ids: ["ct_2"] } },
    ]);
    expect(contacts[0].interactionCount).toBe(11);
    expect(() => searchResponseSchema.parse(contacts)).not.toThrow();
  });
});

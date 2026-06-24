/**
 * Tests for the daemon's contact read relay.
 *
 * handleListContacts (non-search) and handleGetContact relay to the gateway
 * via `ipcCallPersistent`. On the happy path they serve gateway-sourced data
 * and do NOT read the assistant DB. On IPC failure they FAIL CLOSED — the relay
 * error propagates rather than falling back to the assistant DB. getContact
 * surfaces a clean gateway not-found as a 404.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// Capture `log.debug(...)` calls so we can assert the daemon-native-search note
// is emitted on the search path.
const debugLogs: string[] = [];
const realLogger = await import("../util/logger.js");
mock.module("../util/logger.js", () => ({
  ...realLogger,
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get:
        (_target, prop: string) =>
        (...args: unknown[]) => {
          if (prop === "debug") {
            const msg = args.find((a) => typeof a === "string");
            if (typeof msg === "string") debugLogs.push(msg);
          }
        },
    }),
}));

// Guardian display-name override → deterministic sentinel so we can assert it
// is applied to relayed payloads.
const realUserReference = await import("../prompts/user-reference.js");
mock.module("../prompts/user-reference.js", () => ({
  ...realUserReference,
  resolveGuardianName: () => "Your Guardian",
}));

// IPC relay stub — each test sets the response/behavior.
type IpcStub = (method: string, params?: Record<string, unknown>) => unknown;
let ipcStub: IpcStub = () => undefined;
const ipcCalls: Array<{ method: string; params?: Record<string, unknown> }> =
  [];

const realGatewayClient = await import("../ipc/gateway-client.js");
mock.module("../ipc/gateway-client.js", () => ({
  ...realGatewayClient,
  ipcCallPersistent: async (
    method: string,
    params?: Record<string, unknown>,
  ) => {
    ipcCalls.push({ method, params });
    return ipcStub(method, params);
  },
}));

// Assistant-DB fallback stubs — assert these are NOT hit on the happy path,
// and that they ARE hit on the IPC-failure fallback path.
const localCalls: string[] = [];
const realContactStore = await import("../contacts/contact-store.js");
// Capture the args passed to the daemon-native listContacts so tests can assert
// contactType is filtered in SQL (before the limit) rather than relayed.
const listContactsArgs: Array<{
  limit?: number;
  role?: string;
  contactType?: string;
}> = [];
mock.module("../contacts/contact-store.js", () => ({
  ...realContactStore,
  listContacts: (limit?: number, role?: string, contactType?: string) => {
    localCalls.push("listContacts");
    listContactsArgs.push({ limit, role, contactType });
    return [
      {
        id: "local-1",
        displayName: "Local Contact",
        role: role ?? "contact",
        contactType: contactType ?? "human",
        interactionCount: 0,
        channels: [],
      },
    ];
  },
  getContact: (id: string) => {
    localCalls.push("getContact");
    if (id === "missing") return null;
    return {
      id,
      displayName: "Local Contact",
      role: "contact",
      contactType: "human",
      interactionCount: 0,
      channels: [],
    };
  },
  getAssistantContactMetadata: () => {
    localCalls.push("getAssistantContactMetadata");
    return undefined;
  },
  searchContacts: () => {
    localCalls.push("searchContacts");
    return [
      {
        id: "search-1",
        displayName: "Search Contact",
        role: "contact",
        contactType: "human",
        interactionCount: 0,
        channels: [],
      },
    ];
  },
}));

const { handleListContacts, handleGetContact, ROUTES } = (await import(
  "../runtime/routes/contact-routes.js"
)) as typeof import("../runtime/routes/contact-routes.js") & {
  handleListContacts: (q: Record<string, string>) => Promise<{
    ok: boolean;
    contacts: Array<{ id: string; displayName: string; role: string }>;
  }>;
  handleGetContact: (id: string) => Promise<{
    ok: boolean;
    contact: { id: string; displayName: string; role: string };
    assistantMetadata?: unknown;
  }>;
};

/** Invoke the inline `search_contacts` POST route handler with a request body. */
function searchContactsRoute(
  body: Record<string, unknown>,
): Promise<Array<{ id: string; displayName: string; role: string }>> {
  const route = ROUTES.find((r) => r.operationId === "search_contacts");
  if (!route) throw new Error("search_contacts route not found");
  return route.handler({ body }) as Promise<
    Array<{ id: string; displayName: string; role: string }>
  >;
}

function gatewayContact(overrides: Record<string, unknown> = {}) {
  return {
    id: "gw-1",
    displayName: "Gateway Contact",
    role: "contact",
    notes: null,
    contactType: "human",
    interactionCount: 2,
    lastInteraction: 100,
    createdAt: 1699000000,
    updatedAt: 1700000000,
    channels: [
      {
        id: "ch-1",
        contactId: "gw-1",
        type: "telegram",
        address: "tg-001",
        isPrimary: true,
        // The gateway leaves externalUserId null; the daemon's withChannelCompat
        // re-derives it from address on the relayed payload.
        externalUserId: null,
        status: "active",
        policy: "allow",
        verifiedAt: null,
        verifiedVia: null,
        lastSeenAt: null,
        interactionCount: 2,
        lastInteraction: 100,
        revokedReason: null,
        blockedReason: null,
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  ipcStub = () => undefined;
  ipcCalls.length = 0;
  localCalls.length = 0;
  debugLogs.length = 0;
  listContactsArgs.length = 0;
});

describe("handleListContacts relay", () => {
  test("non-search read serves gateway contacts and does NOT read assistant DB", async () => {
    ipcStub = (method) => {
      if (method === "contacts_list_rich") {
        return { ok: true, contacts: [gatewayContact()] };
      }
      return undefined;
    };

    const result = await handleListContacts({ limit: "50" });

    expect(ipcCalls.map((c) => c.method)).toEqual(["contacts_list_rich"]);
    expect(localCalls).toEqual([]);
    expect(result.contacts).toHaveLength(1);
    expect(result.contacts[0].id).toBe("gw-1");
    // The daemon's withChannelCompat re-derives externalUserId = address even
    // though the gateway emits null — the client-facing guarantee holds.
    const ch = (result.contacts[0] as { channels: { address: string; externalUserId: string | null }[] })
      .channels[0];
    expect(ch.externalUserId).toBe(ch.address);
  });

  test("applies guardian display-name override to relayed contacts", async () => {
    ipcStub = () => ({
      ok: true,
      contacts: [gatewayContact({ role: "guardian", displayName: "Real Name" })],
    });

    const result = await handleListContacts({});
    expect(result.contacts[0].displayName).toBe("Your Guardian");
  });

  test("fails closed on IPC failure (no assistant-DB fallback)", async () => {
    ipcStub = () => {
      throw new Error("gateway down");
    };

    await expect(handleListContacts({})).rejects.toThrow("gateway down");

    expect(ipcCalls.map((c) => c.method)).toEqual(["contacts_list_rich"]);
    expect(localCalls).toEqual([]);
  });

  test("search params stay daemon-native and log the boundary note", async () => {
    const result = await handleListContacts({ query: "alice" });

    expect(ipcCalls).toEqual([]);
    expect(localCalls).toContain("searchContacts");
    expect(result.contacts[0].id).toBe("search-1");
    expect(debugLogs.some((m) => m.includes("daemon-native"))).toBe(true);
  });

  test("contactType filter stays daemon-native and does NOT relay to the gateway", async () => {
    // If contactType were relayed, the gateway would apply it AFTER its limit
    // and could under-return. We serve it daemon-native instead (SQL filter
    // before the limit). Assert no relay, local read, and the boundary note.
    const result = await handleListContacts({
      contactType: "assistant",
      limit: "50",
    });

    expect(ipcCalls).toEqual([]);
    expect(localCalls).toEqual(["listContacts"]);
    // contactType + limit are pushed into the SQL-filtered daemon read (the
    // daemon-native listContacts filters contactType BEFORE applying limit).
    expect(listContactsArgs).toEqual([
      { limit: 50, role: undefined, contactType: "assistant" },
    ]);
    expect(result.contacts[0].id).toBe("local-1");
    expect(result.contacts[0].contactType).toBe("assistant");
    expect(debugLogs.some((m) => m.includes("daemon-native"))).toBe(true);
  });

  test("contactType + role both flow into the daemon-native read", async () => {
    await handleListContacts({ contactType: "human", role: "guardian" });

    expect(ipcCalls).toEqual([]);
    expect(listContactsArgs).toEqual([
      { limit: 50, role: "guardian", contactType: "human" },
    ]);
  });
});

describe("search_contacts route relay boundary", () => {
  test("real query stays daemon-native and logs the boundary note", async () => {
    const contacts = await searchContactsRoute({ query: "alice" });

    expect(ipcCalls).toEqual([]);
    expect(localCalls).toContain("searchContacts");
    expect(contacts[0].id).toBe("search-1");
    expect(debugLogs.some((m) => m.includes("daemon-native"))).toBe(true);
  });

  test("real channelAddress stays daemon-native", async () => {
    const contacts = await searchContactsRoute({ channelAddress: "tg-001" });

    expect(ipcCalls).toEqual([]);
    expect(localCalls).toContain("searchContacts");
    expect(contacts[0].id).toBe("search-1");
  });

  test("real channelType stays daemon-native", async () => {
    const contacts = await searchContactsRoute({ channelType: "telegram" });

    expect(ipcCalls).toEqual([]);
    expect(localCalls).toContain("searchContacts");
    expect(contacts[0].id).toBe("search-1");
  });

  test("empty/whitespace query with no filters relays through the gateway", async () => {
    ipcStub = (method) => {
      if (method === "contacts_list_rich") {
        return { ok: true, contacts: [gatewayContact()] };
      }
      return undefined;
    };

    const contacts = await searchContactsRoute({ query: "   " });

    expect(ipcCalls.map((c) => c.method)).toEqual(["contacts_list_rich"]);
    expect(localCalls).toEqual([]);
    expect(contacts[0].id).toBe("gw-1");
    expect(debugLogs.some((m) => m.includes("daemon-native"))).toBe(false);
  });

  test("no params at all relays through the gateway", async () => {
    ipcStub = (method) => {
      if (method === "contacts_list_rich") {
        return { ok: true, contacts: [gatewayContact()] };
      }
      return undefined;
    };

    const contacts = await searchContactsRoute({});

    expect(ipcCalls.map((c) => c.method)).toEqual(["contacts_list_rich"]);
    expect(localCalls).toEqual([]);
    expect(contacts[0].id).toBe("gw-1");
  });
});

describe("handleGetContact relay", () => {
  test("serves the gateway contact and does NOT read the assistant DB", async () => {
    ipcStub = (method) => {
      if (method === "contacts_get_rich") {
        return { ok: true, contact: gatewayContact() };
      }
      return undefined;
    };

    const result = await handleGetContact("gw-1");

    expect(ipcCalls.map((c) => c.method)).toEqual(["contacts_get_rich"]);
    expect(localCalls).toEqual([]);
    expect(result.contact.id).toBe("gw-1");
    expect(result.assistantMetadata).toBeUndefined();
    // Relayed reads must carry contact-level timestamps — the CLI's detail
    // formatter calls new Date(createdAt/updatedAt) unconditionally, so dropping
    // them surfaces as a RangeError ("Invalid time value").
    const contact = result.contact as { createdAt?: number; updatedAt?: number };
    expect(contact.createdAt).toBe(1699000000);
    expect(contact.updatedAt).toBe(1700000000);
  });

  test("applies guardian display-name override", async () => {
    ipcStub = () => ({
      ok: true,
      contact: gatewayContact({ role: "guardian", displayName: "Real Name" }),
    });

    const result = await handleGetContact("gw-1");
    expect(result.contact.displayName).toBe("Your Guardian");
  });

  test("returns assistantMetadata when present", async () => {
    ipcStub = () => ({
      ok: true,
      contact: gatewayContact(),
      assistantMetadata: {
        contactId: "gw-1",
        species: "vellum",
        metadata: { model: "opus" },
      },
    });

    const result = await handleGetContact("gw-1");
    expect(result.assistantMetadata).toEqual({
      contactId: "gw-1",
      species: "vellum",
      metadata: { model: "opus" },
    });
  });

  test("throws NotFoundError on gateway not-found (no fallback)", async () => {
    ipcStub = () => null;

    await expect(handleGetContact("nope")).rejects.toThrow(
      'Contact "nope" not found',
    );
    expect(localCalls).toEqual([]);
  });

  test("fails closed on IPC transport failure (no assistant-DB fallback)", async () => {
    ipcStub = () => {
      throw new Error("gateway down");
    };

    await expect(handleGetContact("gw-1")).rejects.toThrow("gateway down");

    expect(ipcCalls.map((c) => c.method)).toEqual(["contacts_get_rich"]);
    expect(localCalls).toEqual([]);
  });

  test("clean gateway not-found surfaces as a 404 for unknown ids", async () => {
    ipcStub = () => null;

    await expect(handleGetContact("missing")).rejects.toThrow(
      'Contact "missing" not found',
    );
    expect(ipcCalls.map((c) => c.method)).toEqual(["contacts_get_rich"]);
    expect(localCalls).toEqual([]);
  });
});

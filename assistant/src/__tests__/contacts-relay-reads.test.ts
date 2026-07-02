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

// Role + the guardian name override derive from the gateway guardian id set.
// Drive it deterministically per test.
let guardianIds = new Set<string>();
mock.module("../contacts/guardian-contact-reader.js", () => ({
  getGuardianContactIds: async () => guardianIds,
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
  contactType?: string;
}> = [];
mock.module("../contacts/contact-store.js", () => ({
  ...realContactStore,
  listContacts: (limit?: number, contactType?: string) => {
    localCalls.push("listContacts");
    listContactsArgs.push({ limit, contactType });
    return [
      {
        id: "local-1",
        displayName: "Local Contact",
        role: "contact",
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
  guardianIds = new Set();
});

/**
 * Pin the daemon-native gateway boundary: the query/filter is resolved LOCALLY,
 * so the gateway is NEVER asked to RESOLVE it. The only permitted gateway IPC on
 * these paths is the telemetry overlay (`hydrateTelemetryFromGateway`), and it
 * must carry ONLY the already-resolved result-set `ids` — never the
 * query/contactType/channelType/channelAddress/role/limit filter params. The
 * exact `toEqual({ ids })` match guarantees no filter key leaked into the relay.
 */
function expectOnlyIdsScopedTelemetryHydration(expectedIds: string[]) {
  expect(ipcCalls.map((c) => c.method)).toEqual(["contacts_list_rich"]);
  expect(ipcCalls[0]?.params).toEqual({ ids: expectedIds });
}

/** Telemetry-overlay stub: gateway returns rich telemetry for the ids-scoped
 * hydration read, keyed to the locally-resolved contact. */
function telemetryHydrationStub(id: string, interactionCount: number): IpcStub {
  return (method) => {
    if (method === "contacts_list_rich") {
      return { ok: true, contacts: [gatewayContact({ id, interactionCount })] };
    }
    return undefined;
  };
}

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

  test("trusts the gateway-relayed guardian role + applies the name override regardless of the id-set cache", async () => {
    // Relayed read carries role "guardian" from the gateway. The guardian id
    // set is empty/stale (rebind race) but must NOT downgrade the role; the
    // name override keys off the relayed role.
    guardianIds = new Set();
    ipcStub = () => ({
      ok: true,
      contacts: [
        gatewayContact({ role: "guardian", displayName: "Real Name" }),
      ],
    });

    const result = await handleListContacts({});
    expect(result.contacts[0].role).toBe("guardian");
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

  test("search params stay daemon-native; query stays local while ids-scoped gateway telemetry is overlaid", async () => {
    // The query is resolved LOCALLY (searchContacts) and the boundary note is
    // logged. The gateway is NOT asked to resolve the query — its only call is
    // the ids-scoped telemetry overlay, which then hydrates interactionCount.
    ipcStub = telemetryHydrationStub("search-1", 7);

    const result = await handleListContacts({ query: "alice" });

    expect(localCalls).toContain("searchContacts");
    expectOnlyIdsScopedTelemetryHydration(["search-1"]);
    expect(result.contacts[0].id).toBe("search-1");
    expect(result.contacts[0].interactionCount).toBe(7);
    expect(debugLogs.some((m) => m.includes("daemon-native"))).toBe(true);
  });

  test("contactType filter stays daemon-native; filter never relayed, only ids-scoped telemetry overlaid", async () => {
    // If contactType were relayed, the gateway would apply it AFTER its limit
    // and could under-return. We resolve it daemon-native instead (SQL filter
    // BEFORE the limit). The gateway is consulted ONLY for the ids-scoped
    // telemetry overlay — never to resolve the contactType filter.
    ipcStub = telemetryHydrationStub("local-1", 3);

    const result = await handleListContacts({
      contactType: "assistant",
      limit: "50",
    });

    expect(localCalls).toEqual(["listContacts"]);
    // contactType + limit are pushed into the SQL-filtered daemon read (the
    // daemon-native listContacts filters contactType BEFORE applying limit).
    expect(listContactsArgs).toEqual([
      { limit: 50, contactType: "assistant" },
    ]);
    expectOnlyIdsScopedTelemetryHydration(["local-1"]);
    expect(result.contacts[0].id).toBe("local-1");
    expect(result.contacts[0].contactType).toBe("assistant");
    expect(result.contacts[0].interactionCount).toBe(3);
    expect(debugLogs.some((m) => m.includes("daemon-native"))).toBe(true);
  });

  test("contactType filters daemon-native; role is gateway-owned and no longer a local predicate", async () => {
    await handleListContacts({ contactType: "human", role: "guardian" });

    expect(listContactsArgs).toEqual([{ limit: 50, contactType: "human" }]);
    // `role` is neither pushed to the local SQL read NOR relayed to the gateway
    // as a filter — the sole gateway call is the ids-scoped telemetry overlay.
    expectOnlyIdsScopedTelemetryHydration(["local-1"]);
  });
});

describe("search_contacts route relay boundary", () => {
  test("real query stays daemon-native; query stays local while ids-scoped telemetry is overlaid", async () => {
    // Query resolved locally; boundary note logged. The gateway is only asked
    // for the ids-scoped telemetry overlay, never to resolve the query.
    ipcStub = telemetryHydrationStub("search-1", 5);

    const contacts = await searchContactsRoute({ query: "alice" });

    expect(localCalls).toContain("searchContacts");
    expectOnlyIdsScopedTelemetryHydration(["search-1"]);
    expect(contacts[0].id).toBe("search-1");
    expect(
      (contacts[0] as { interactionCount?: number | null }).interactionCount,
    ).toBe(5);
    expect(debugLogs.some((m) => m.includes("daemon-native"))).toBe(true);
  });

  test("real channelAddress stays daemon-native; filter stays local, only ids-scoped telemetry overlaid", async () => {
    ipcStub = telemetryHydrationStub("search-1", 5);

    const contacts = await searchContactsRoute({ channelAddress: "tg-001" });

    expect(localCalls).toContain("searchContacts");
    // channelAddress never reaches the gateway — the sole call carries only ids.
    expectOnlyIdsScopedTelemetryHydration(["search-1"]);
    expect(contacts[0].id).toBe("search-1");
  });

  test("real channelType stays daemon-native; filter stays local, only ids-scoped telemetry overlaid", async () => {
    ipcStub = telemetryHydrationStub("search-1", 5);

    const contacts = await searchContactsRoute({ channelType: "telegram" });

    expect(localCalls).toContain("searchContacts");
    // channelType never reaches the gateway — the sole call carries only ids.
    expectOnlyIdsScopedTelemetryHydration(["search-1"]);
    expect(contacts[0].id).toBe("search-1");
  });

  test("telemetry hydration is FAIL-SOFT: a throwing gateway read still returns locally-resolved contacts with null telemetry", async () => {
    ipcStub = (method) => {
      if (method === "contacts_list_rich") {
        throw new Error("gateway telemetry down");
      }
      return undefined;
    };

    const contacts = await searchContactsRoute({ query: "alice" });

    // The query is resolved locally; the throwing telemetry overlay degrades to
    // null rather than propagating, so the search STILL returns its local result.
    expect(localCalls).toContain("searchContacts");
    expectOnlyIdsScopedTelemetryHydration(["search-1"]);
    expect(contacts[0].id).toBe("search-1");
    expect(
      (contacts[0] as { interactionCount?: number | null }).interactionCount,
    ).toBeNull();
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

  test("trusts the gateway-relayed guardian role + applies the name override regardless of the id-set cache", async () => {
    // Empty/stale guardian id set must not downgrade a relayed guardian.
    guardianIds = new Set();
    ipcStub = () => ({
      ok: true,
      contact: gatewayContact({ role: "guardian", displayName: "Real Name" }),
    });

    const result = await handleGetContact("gw-1");
    expect(result.contact.role).toBe("guardian");
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

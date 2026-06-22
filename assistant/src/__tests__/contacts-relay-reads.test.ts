/**
 * Tests for the daemon's contact read relay (PR 3).
 *
 * handleListContacts (non-search) and handleGetContact relay to the gateway
 * via `ipcCallPersistent`. On the happy path they serve gateway-sourced data
 * and do NOT read the assistant DB. On IPC failure they fall back to the
 * assistant-DB read and log a warning. getContact still 404s for unknown ids.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const realLogger = await import("../util/logger.js");
mock.module("../util/logger.js", () => ({
  ...realLogger,
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
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
mock.module("../contacts/contact-store.js", () => ({
  ...realContactStore,
  listContacts: () => {
    localCalls.push("listContacts");
    return [
      {
        id: "local-1",
        displayName: "Local Contact",
        role: "contact",
        contactType: "human",
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
}));

const { handleListContacts, handleGetContact } = (await import(
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

function gatewayContact(overrides: Record<string, unknown> = {}) {
  return {
    id: "gw-1",
    displayName: "Gateway Contact",
    role: "contact",
    notes: null,
    contactType: "human",
    interactionCount: 2,
    lastInteraction: 100,
    channels: [
      {
        id: "ch-1",
        contactId: "gw-1",
        type: "telegram",
        address: "tg-001",
        isPrimary: true,
        externalUserId: "tg-001",
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
  });

  test("applies guardian display-name override to relayed contacts", async () => {
    ipcStub = () => ({
      ok: true,
      contacts: [gatewayContact({ role: "guardian", displayName: "Real Name" })],
    });

    const result = await handleListContacts({});
    expect(result.contacts[0].displayName).toBe("Your Guardian");
  });

  test("falls back to the assistant DB on IPC failure", async () => {
    ipcStub = () => {
      throw new Error("gateway down");
    };

    const result = await handleListContacts({});

    expect(ipcCalls.map((c) => c.method)).toEqual(["contacts_list_rich"]);
    expect(localCalls).toContain("listContacts");
    expect(result.contacts[0].id).toBe("local-1");
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

  test("falls back to the assistant DB on IPC transport failure", async () => {
    ipcStub = () => {
      throw new Error("gateway down");
    };

    const result = await handleGetContact("gw-1");

    expect(ipcCalls.map((c) => c.method)).toEqual(["contacts_get_rich"]);
    expect(localCalls).toContain("getContact");
    expect(result.contact.id).toBe("gw-1");
  });

  test("fallback path still 404s for unknown ids", async () => {
    ipcStub = () => {
      throw new Error("gateway down");
    };

    await expect(handleGetContact("missing")).rejects.toThrow(
      'Contact "missing" not found',
    );
    expect(localCalls).toContain("getContact");
  });
});

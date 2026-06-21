import { describe, test, expect, mock, afterEach } from "bun:test";
import type { GatewayConfig } from "../config.js";
import { initSigningKey } from "../auth/token-service.js";

const TEST_SIGNING_KEY = Buffer.from("test-signing-key-at-least-32-bytes-long");
initSigningKey(TEST_SIGNING_KEY);

type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
let fetchMock: ReturnType<typeof mock<FetchFn>> = mock(
  async () => new Response(),
);

mock.module("../fetch.js", () => ({
  fetchImpl: (...args: Parameters<FetchFn>) => fetchMock(...args),
}));

// ── Assistant DB proxy mocks ──────────────────────────────────────────────────
type DbQueryFn = (sql: string, bind?: unknown[]) => Promise<Record<string, unknown>[]>;
let assistantDbQueryMock: ReturnType<typeof mock<DbQueryFn>> = mock(async () => []);

type DbRunFn = (sql: string, bind?: unknown[]) => Promise<{ changes: number; lastInsertRowid: number }>;
let assistantDbRunMock: ReturnType<typeof mock<DbRunFn>> = mock(async () => ({ changes: 1, lastInsertRowid: 0 }));

mock.module("../db/assistant-db-proxy.js", () => ({
  assistantDbQuery: (...args: Parameters<DbQueryFn>) => assistantDbQueryMock(...args),
  assistantDbRun: (...args: Parameters<DbRunFn>) => assistantDbRunMock(...args),
}));

// ── IPC assistant client mock ─────────────────────────────────────────────────
type IpcCallFn = (method: string, params: unknown) => Promise<unknown>;
let ipcCallAssistantMock: ReturnType<typeof mock<IpcCallFn>> = mock(async () => ({}));

class IpcHandlerError extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor(message: string, statusCode: number, code: string) {
    super(message);
    this.name = "IpcHandlerError";
    this.statusCode = statusCode;
    this.code = code;
  }
}
class IpcTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IpcTransportError";
  }
}

mock.module("../ipc/assistant-client.js", () => ({
  ipcCallAssistant: (...args: Parameters<IpcCallFn>) => ipcCallAssistantMock(...args),
  IpcHandlerError,
  IpcTransportError,
}));

// ── ContactStore mock ─────────────────────────────────────────────────────────
// upsertContact is now async and returns a full ContactWithChannels shape; the
// service layer owns the assistant-DB dual-write internally.
const DEFAULT_MOCK_CONTACT = {
  id: "ct_mock",
  displayName: "Mock Contact",
  notes: null as string | null,
  role: "contact",
  contactType: "human",
  principalId: null as string | null,
  userFile: null as string | null,
  createdAt: 1000000,
  updatedAt: 1000000,
  interactionCount: 0,
  lastInteraction: null as number | null,
  channels: [] as unknown[],
};

type UpsertResult = { contact: typeof DEFAULT_MOCK_CONTACT; created: boolean };
type UpsertFn = (params: unknown) => Promise<UpsertResult>;
let contactStoreUpsertMock: ReturnType<typeof mock<UpsertFn>> = mock(async () => ({
  contact: DEFAULT_MOCK_CONTACT,
  created: false,
}));

type ListFn = (opts?: {
  limit?: number;
  role?: string;
}) => Promise<typeof DEFAULT_MOCK_CONTACT[]>;
let contactStoreListMock: ReturnType<typeof mock<ListFn>> = mock(async () => []);

type GetFn = (contactId: string) => Promise<typeof DEFAULT_MOCK_CONTACT | null>;
let contactStoreGetMock: ReturnType<typeof mock<GetFn>> = mock(async () => null);

type UpdateChannelFn = (channelId: string, params: {
  status?: string;
  policy?: string;
  reason?: string | null;
}) => { id: string; contactId: string; status: string; policy: string } | null;
let contactStoreUpdateChannelMock: ReturnType<typeof mock<UpdateChannelFn>> = mock(() => null);

type DualWriteChannelFn = (channelId: string, params: Record<string, unknown>) => Promise<void>;
let contactStoreDualWriteChannelMock: ReturnType<typeof mock<DualWriteChannelFn>> = mock(async () => {});

type MergeFn = (keepId: string, mergeId: string) => Promise<typeof DEFAULT_MOCK_CONTACT | null>;
let contactStoreMergeMock: ReturnType<typeof mock<MergeFn>> = mock(async () => null);

// ── Invite method mocks ───────────────────────────────────────────────────────
type InviteRow = {
  id: string;
  sourceChannel: string;
  inviteCodeHash: string;
  contactId: string;
  note: string | null;
  maxUses: number;
  useCount: number;
  expiresAt: number;
  status: string;
  createdAt: number;
  updatedAt: number;
};
const DEFAULT_INVITE: InviteRow = {
  id: "inv_1",
  sourceChannel: "telegram",
  inviteCodeHash: "hash_1",
  contactId: "ct_1",
  note: null,
  maxUses: 1,
  useCount: 0,
  expiresAt: 2000000,
  status: "active",
  createdAt: 1000000,
  updatedAt: 1000000,
};

type GetContactFn = (contactId: string) => { id: string } | undefined;
let contactStoreGetContactMock: ReturnType<typeof mock<GetContactFn>> = mock(
  () => ({ id: "ct_1" }),
);

type ListInvitesFn = (params: unknown) => InviteRow[];
let contactStoreListInvitesMock: ReturnType<typeof mock<ListInvitesFn>> = mock(
  () => [],
);

type CreateInviteFn = (params: unknown) => InviteRow;
let contactStoreCreateInviteMock: ReturnType<typeof mock<CreateInviteFn>> = mock(
  () => DEFAULT_INVITE,
);

type RevokeInviteFn = (inviteId: string) => InviteRow | null;
let contactStoreRevokeInviteMock: ReturnType<typeof mock<RevokeInviteFn>> = mock(
  () => DEFAULT_INVITE,
);

type RecordRedemptionFn = (params: unknown) => {
  updated: boolean;
  row: InviteRow | null;
};
let contactStoreRecordRedemptionMock: ReturnType<
  typeof mock<RecordRedemptionFn>
> = mock(() => ({ updated: true, row: DEFAULT_INVITE }));

type GetInviteByIdFn = (inviteId: string) => InviteRow | null;
let contactStoreGetInviteByIdMock: ReturnType<typeof mock<GetInviteByIdFn>> =
  mock(() => DEFAULT_INVITE);

mock.module("../db/contact-store.js", () => ({
  ContactStore: class MockContactStore {
    upsertContact(...args: Parameters<UpsertFn>) {
      return contactStoreUpsertMock(...args);
    }
    getContact(contactId: string) {
      return contactStoreGetContactMock(contactId);
    }
    listInvites(params: unknown) {
      return contactStoreListInvitesMock(params);
    }
    createInvite(params: unknown) {
      return contactStoreCreateInviteMock(params);
    }
    revokeInvite(inviteId: string) {
      return contactStoreRevokeInviteMock(inviteId);
    }
    recordInviteRedemption(params: unknown) {
      return contactStoreRecordRedemptionMock(params);
    }
    getInviteById(inviteId: string) {
      return contactStoreGetInviteByIdMock(inviteId);
    }
    async listContactsWithInfo(opts?: {
      limit?: number;
      role?: string;
      contactType?: string;
    }) {
      return contactStoreListMock(opts);
    }
    async getContactWithInfo(contactId: string) {
      return contactStoreGetMock(contactId);
    }
    async updateChannelStatus(channelId: string, params: {
      status?: string;
      policy?: string;
      reason?: string | null;
    }) {
      return contactStoreUpdateChannelMock(channelId, params);
    }
    async dualWriteChannelStatusToAssistantDb(
      channelId: string,
      params: Record<string, unknown>,
    ) {
      return contactStoreDualWriteChannelMock(channelId, params);
    }
    async mergeContacts(keepId: string, mergeId: string) {
      return contactStoreMergeMock(keepId, mergeId);
    }
  },
  CannotRevokeBlockedError: class CannotRevokeBlockedError extends Error {
    readonly channelId: string;
    constructor(channelId: string) {
      super("Cannot revoke a blocked channel. Unblock it first or leave it blocked.");
      this.name = "CannotRevokeBlockedError";
      this.channelId = channelId;
    }
  },
  MergeContactsError: class MergeContactsError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "MergeContactsError";
    }
  },
}));

const { createContactsControlPlaneProxyHandler } =
  await import("../http/routes/contacts-control-plane-proxy.js");

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const merged: GatewayConfig = {
    assistantRuntimeBaseUrl: "http://localhost:7821",
    routingEntries: [],
    defaultAssistantId: undefined,
    unmappedPolicy: "reject",
    port: 7830,
    runtimeProxyRequireAuth: true,
    shutdownDrainMs: 5000,
    runtimeTimeoutMs: 30000,
    runtimeMaxRetries: 2,
    runtimeInitialBackoffMs: 500,
    maxWebhookPayloadBytes: 1048576,
    logFile: { dir: undefined, retentionDays: 30 },
    maxAttachmentBytes: {
      telegram: 50 * 1024 * 1024,
      slack: 100 * 1024 * 1024,
      whatsapp: 16 * 1024 * 1024,
      default: 50 * 1024 * 1024,
    },
    maxAttachmentConcurrency: 3,
    gatewayInternalBaseUrl: "http://127.0.0.1:7830",
    trustProxy: false,
    ...overrides,
  };
  return merged;
}

afterEach(() => {
  fetchMock = mock(async () => new Response());
  assistantDbQueryMock = mock(async () => []);
  assistantDbRunMock = mock(async () => ({ changes: 1, lastInsertRowid: 0 }));
  ipcCallAssistantMock = mock(async () => ({}));
  contactStoreUpsertMock = mock(async () => ({
    contact: DEFAULT_MOCK_CONTACT,
    created: false,
  }));
  contactStoreListMock = mock(async () => []);
  contactStoreGetMock = mock(async () => null);
  contactStoreUpdateChannelMock = mock(() => null);
  contactStoreDualWriteChannelMock = mock(async () => {});
  contactStoreMergeMock = mock(async () => null);
  contactStoreGetContactMock = mock(() => ({ id: "ct_1" }));
  contactStoreListInvitesMock = mock(() => []);
  contactStoreCreateInviteMock = mock(() => DEFAULT_INVITE);
  contactStoreRevokeInviteMock = mock(() => DEFAULT_INVITE);
  contactStoreRecordRedemptionMock = mock(() => ({
    updated: true,
    row: DEFAULT_INVITE,
  }));
  contactStoreGetInviteByIdMock = mock(() => DEFAULT_INVITE);
});

describe("contacts control-plane proxy", () => {
  test("forwards contact endpoints to the runtime", async () => {
    const captured: string[] = [];
    fetchMock = mock(async (input: string | URL | Request) => {
      captured.push(String(input));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const handler = createContactsControlPlaneProxyHandler(makeConfig());

    // Use ?query= to force proxy fallback (list is now gateway-native for
    // non-search queries).
    await handler.handleListContacts(
      new Request("http://localhost:7830/v1/contacts?limit=10&query=alice"),
    );
    // GetContact falls back to proxy when the store throws; seed a throw.
    contactStoreGetMock = mock(async () => {
      throw new Error("force proxy fallback");
    });
    await handler.handleGetContact(
      new Request("http://localhost:7830/v1/contacts/ct_1"),
      "ct_1",
    );

    expect(captured).toEqual([
      "http://localhost:7821/v1/contacts?limit=10&query=alice",
      "http://localhost:7821/v1/contacts/ct_1",
    ]);
  });

  test("invite handlers never proxy to the runtime", async () => {
    // All five invite handlers are gateway-native; none should call fetch.
    const handler = createContactsControlPlaneProxyHandler(makeConfig());

    await handler.handleListInvites(
      new Request("http://localhost:7830/v1/contacts/invites?status=active"),
    );
    await handler.handleCreateInvite(
      new Request("http://localhost:7830/v1/contacts/invites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contactId: "ct_1", sourceChannel: "telegram" }),
      }),
    );
    await handler.handleRedeemInvite(
      new Request("http://localhost:7830/v1/contacts/invites/redeem", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "tok", sourceChannel: "telegram" }),
      }),
    );
    await handler.handleRevokeInvite(
      new Request("http://localhost:7830/v1/contacts/invites/inv_123", {
        method: "DELETE",
      }),
      "inv_123",
    );
    await handler.handleCallInvite(
      new Request("http://localhost:7830/v1/contacts/invites/inv_123/call", {
        method: "POST",
      }),
      "inv_123",
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("returns 502 when runtime is unreachable", async () => {
    fetchMock = mock(async () => {
      throw new Error("Connection refused");
    });

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    // Use ?query= to force proxy fallback path (list is gateway-native otherwise).
    const res = await handler.handleListContacts(
      new Request("http://localhost:7830/v1/contacts?query=test"),
    );

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Bad Gateway" });
  });

  test("passes through successful response body", async () => {
    const responsePayload = {
      contacts: [{ id: "ct_1", name: "Alice" }],
      total: 1,
    };
    fetchMock = mock(async () => {
      return new Response(JSON.stringify(responsePayload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleListContacts(
      new Request("http://localhost:7830/v1/contacts?query=test"),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(responsePayload);
    expect(res.headers.get("content-type")).toBe("application/json");
  });

  test("strips hop-by-hop headers from upstream response", async () => {
    fetchMock = mock(async () => {
      return new Response("ok", {
        status: 200,
        headers: {
          "content-type": "text/plain",
          connection: "keep-alive",
          "keep-alive": "timeout=5",
          "x-custom": "preserved",
        },
      });
    });

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleListContacts(
      new Request("http://localhost:7830/v1/contacts?query=test"),
    );

    expect(res.status).toBe(200);
    expect(res.headers.has("connection")).toBe(false);
    expect(res.headers.has("keep-alive")).toBe(false);
    expect(res.headers.get("x-custom")).toBe("preserved");
  });
});

describe("handleUpsertContact (gateway-native)", () => {
  test("returns 400 when displayName is missing", async () => {
    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleUpsertContact(
      new Request("http://localhost:7830/v1/contacts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contactType: "human" }),
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toMatch(/displayName/);
  });

  test("returns 400 for invalid contactType", async () => {
    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleUpsertContact(
      new Request("http://localhost:7830/v1/contacts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: "Alice", contactType: "robot" }),
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toMatch(/contactType/);
  });

  test("creates contact natively and returns contact shape", async () => {
    const mockContact = {
      ...DEFAULT_MOCK_CONTACT,
      id: "ct_abc123",
      displayName: "Alice",
    };
    contactStoreUpsertMock = mock(async () => ({
      contact: mockContact,
      created: true,
    }));

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleUpsertContact(
      new Request("http://localhost:7830/v1/contacts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: "Alice" }),
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.contact.id).toBe("ct_abc123");
    expect(body.contact.displayName).toBe("Alice");
    expect(body.contact.channels).toEqual([]);
    // Service layer owns the upsert + dual-write.
    expect(contactStoreUpsertMock).toHaveBeenCalledTimes(1);
    const [params] = contactStoreUpsertMock.mock.calls[0] as [
      Record<string, unknown>,
    ];
    expect(params.displayName).toBe("Alice");
  });

  test("strips role and principalId from request body (privilege escalation guard)", async () => {
    // Regression: a malicious caller MUST NOT be able to rebind the guardian
    // by sending `role: "guardian"` + their own principalId via POST
    // /v1/contacts. The route handler must never pass those fields through
    // to the service layer; ContactStore's params surface must not include
    // them.
    contactStoreUpsertMock = mock(async () => ({
      contact: { ...DEFAULT_MOCK_CONTACT, id: "ct_target", role: "guardian" },
      created: false,
    }));

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleUpsertContact(
      new Request("http://localhost:7830/v1/contacts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "ct_target",
          displayName: "Pwn3d",
          role: "guardian",
          principalId: "attacker-principal-id",
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect(contactStoreUpsertMock).toHaveBeenCalledTimes(1);
    const [params] = contactStoreUpsertMock.mock.calls[0] as [
      Record<string, unknown>,
    ];
    expect(params.role).toBeUndefined();
    expect(params.principalId).toBeUndefined();
    // The other fields still flow through.
    expect(params.id).toBe("ct_target");
    expect(params.displayName).toBe("Pwn3d");
  });

  test("returns 400 when body is invalid JSON", async () => {
    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleUpsertContact(
      new Request("http://localhost:7830/v1/contacts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-json",
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  test("returns 400 when channel.type is missing", async () => {
    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleUpsertContact(
      new Request("http://localhost:7830/v1/contacts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName: "Alice",
          channels: [{ address: "alice@example.com" }],
        }),
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toMatch(/channel\.type/);
    expect(contactStoreUpsertMock).not.toHaveBeenCalled();
  });

  test("returns 400 when channel.address is missing", async () => {
    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleUpsertContact(
      new Request("http://localhost:7830/v1/contacts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName: "Alice",
          channels: [{ type: "email" }],
        }),
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toMatch(/channel\.address/);
    expect(contactStoreUpsertMock).not.toHaveBeenCalled();
  });

  test("returns 400 when channel.address is empty/whitespace", async () => {
    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleUpsertContact(
      new Request("http://localhost:7830/v1/contacts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName: "Alice",
          channels: [{ type: "email", address: "   " }],
        }),
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toMatch(/channel\.address/);
    expect(contactStoreUpsertMock).not.toHaveBeenCalled();
  });

  test("rejects unsupported species (e.g. openclaw)", async () => {
    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleUpsertContact(
      new Request("http://localhost:7830/v1/contacts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName: "Some Bot",
          contactType: "assistant",
          assistantMetadata: { species: "openclaw", metadata: {} },
        }),
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toMatch(/species/);
    expect(contactStoreUpsertMock).not.toHaveBeenCalled();
  });

  test("rejects vellum metadata missing assistantId", async () => {
    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleUpsertContact(
      new Request("http://localhost:7830/v1/contacts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName: "Vellum Bot",
          contactType: "assistant",
          assistantMetadata: {
            species: "vellum",
            metadata: { gatewayUrl: "https://x.example" },
          },
        }),
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toMatch(/assistantId/);
    expect(contactStoreUpsertMock).not.toHaveBeenCalled();
  });

  test("rejects vellum metadata missing gatewayUrl", async () => {
    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleUpsertContact(
      new Request("http://localhost:7830/v1/contacts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName: "Vellum Bot",
          contactType: "assistant",
          assistantMetadata: {
            species: "vellum",
            metadata: { assistantId: "asst_123" },
          },
        }),
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toMatch(/gatewayUrl/);
    expect(contactStoreUpsertMock).not.toHaveBeenCalled();
  });

  test("accepts vellum assistant with full metadata", async () => {
    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleUpsertContact(
      new Request("http://localhost:7830/v1/contacts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName: "Vellum Bot",
          contactType: "assistant",
          assistantMetadata: {
            species: "vellum",
            metadata: {
              assistantId: "asst_123",
              gatewayUrl: "https://gw.example.com",
            },
          },
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect(contactStoreUpsertMock).toHaveBeenCalledTimes(1);
    const [params] = contactStoreUpsertMock.mock.calls[0] as [
      { assistantMetadata?: { species: string; metadata?: Record<string, unknown> } },
    ];
    expect(params.assistantMetadata?.species).toBe("vellum");
    expect(params.assistantMetadata?.metadata?.assistantId).toBe("asst_123");
  });
});

describe("handleListContacts (gateway-native)", () => {
  test("returns contacts from gateway-native read", async () => {
    const mockContacts = [
      { ...DEFAULT_MOCK_CONTACT, id: "c1", displayName: "Alice" },
      { ...DEFAULT_MOCK_CONTACT, id: "c2", displayName: "Bob" },
    ];
    contactStoreListMock = mock(async () => mockContacts);

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleListContacts(
      new Request("http://localhost:7830/v1/contacts"),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.contacts).toHaveLength(2);
    expect(body.contacts[0].id).toBe("c1");
    expect(body.contacts[0].displayName).toBe("Alice");
    // Compat: externalUserId = address on each channel.
    // (DEFAULT_MOCK_CONTACT has empty channels, so this is vacuous here.)
    expect(contactStoreListMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("falls back to proxy for contactType filter (assistant-owned field)", async () => {
    fetchMock = mock(
      async () =>
        new Response(JSON.stringify({ ok: true, contacts: [] }), {
          headers: { "content-type": "application/json" },
        }),
    );

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    await handler.handleListContacts(
      new Request("http://localhost:7830/v1/contacts?contactType=human"),
    );

    expect(contactStoreListMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("falls back to proxy for search-style queries (query param)", async () => {
    fetchMock = mock(
      async () =>
        new Response(JSON.stringify({ ok: true, contacts: [] }), {
          headers: { "content-type": "application/json" },
        }),
    );

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    await handler.handleListContacts(
      new Request("http://localhost:7830/v1/contacts?query=alice"),
    );

    expect(contactStoreListMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("falls back to proxy for channelAddress search", async () => {
    fetchMock = mock(
      async () =>
        new Response(JSON.stringify({ ok: true, contacts: [] }), {
          headers: { "content-type": "application/json" },
        }),
    );

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    await handler.handleListContacts(
      new Request(
        "http://localhost:7830/v1/contacts?channelAddress=alice@example.com",
      ),
    );

    expect(contactStoreListMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("returns 400 for invalid contactType", async () => {
    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleListContacts(
      new Request("http://localhost:7830/v1/contacts?contactType=robot"),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toMatch(/contactType/);
    expect(contactStoreListMock).not.toHaveBeenCalled();
  });

  test("falls back to proxy on gateway-native read error", async () => {
    contactStoreListMock = mock(async () => {
      throw new Error("gateway DB unavailable");
    });
    fetchMock = mock(
      async () =>
        new Response(JSON.stringify({ ok: true, contacts: [] }), {
          headers: { "content-type": "application/json" },
        }),
    );

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleListContacts(
      new Request("http://localhost:7830/v1/contacts"),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
  });

  test("includes externalUserId compat field on channels", async () => {
    const mockContact = {
      ...DEFAULT_MOCK_CONTACT,
      id: "c1",
      channels: [
        {
          id: "ch1",
          contactId: "c1",
          type: "telegram",
          address: "@alice",
          isPrimary: true,
          externalChatId: "12345",
          status: "active",
          policy: "allow",
          verifiedAt: null,
          verifiedVia: null,
          inviteId: null,
          revokedReason: null,
          blockedReason: null,
          lastSeenAt: null,
          interactionCount: 0,
          lastInteraction: null,
          createdAt: 100,
          updatedAt: null,
        },
      ],
    };
    contactStoreListMock = mock(async () => [mockContact]);

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleListContacts(
      new Request("http://localhost:7830/v1/contacts"),
    );

    const body = await res.json();
    expect(body.contacts[0].channels[0].externalUserId).toBe("@alice");
  });
});

describe("handleGetContact (gateway-native)", () => {
  test("returns contact from gateway-native read", async () => {
    const mockContact = {
      ...DEFAULT_MOCK_CONTACT,
      id: "c1",
      displayName: "Alice",
    };
    contactStoreGetMock = mock(async () => mockContact);

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleGetContact(
      new Request("http://localhost:7830/v1/contacts/c1"),
      "c1",
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.contact.id).toBe("c1");
    expect(body.contact.displayName).toBe("Alice");
    expect(contactStoreGetMock).toHaveBeenCalledWith("c1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("returns 404 when contact not found", async () => {
    contactStoreGetMock = mock(async () => null);

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleGetContact(
      new Request("http://localhost:7830/v1/contacts/nope"),
      "nope",
    );

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  test("includes assistantMetadata with contactId for assistant contactType", async () => {
    const mockContact = {
      ...DEFAULT_MOCK_CONTACT,
      id: "c1",
      contactType: "assistant",
      assistantMetadata: { species: "vellum", metadata: { assistantId: "asst_1" } },
    };
    contactStoreGetMock = mock(async () => mockContact);

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleGetContact(
      new Request("http://localhost:7830/v1/contacts/c1"),
      "c1",
    );

    const body = await res.json();
    expect(body.assistantMetadata).toEqual({
      contactId: "c1",
      species: "vellum",
      metadata: { assistantId: "asst_1" },
    });
  });

  test("omits assistantMetadata for human contactType", async () => {
    const mockContact = {
      ...DEFAULT_MOCK_CONTACT,
      id: "c1",
      contactType: "human",
      assistantMetadata: null,
    };
    contactStoreGetMock = mock(async () => mockContact);

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleGetContact(
      new Request("http://localhost:7830/v1/contacts/c1"),
      "c1",
    );

    const body = await res.json();
    expect(body.assistantMetadata).toBeUndefined();
  });

  test("falls back to proxy on gateway-native read error", async () => {
    contactStoreGetMock = mock(async () => {
      throw new Error("gateway DB unavailable");
    });
    fetchMock = mock(
      async () =>
        new Response(
          JSON.stringify({ ok: true, contact: DEFAULT_MOCK_CONTACT }),
          { headers: { "content-type": "application/json" } },
        ),
    );

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleGetContact(
      new Request("http://localhost:7830/v1/contacts/c1"),
      "c1",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
  });
});

describe("handleUpdateContactChannel (gateway-native)", () => {
  const MOCK_CHANNEL = {
    id: "ch_1",
    contactId: "ct_mock",
    status: "active",
    policy: "allow",
  };

  test("updates channel status natively and returns parent contact", async () => {
    contactStoreUpdateChannelMock = mock(() => ({
      ...MOCK_CHANNEL,
      status: "revoked",
    }));
    contactStoreGetMock = mock(async () => ({
      ...DEFAULT_MOCK_CONTACT,
      id: "ct_mock",
    }));

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleUpdateContactChannel(
      new Request("http://localhost:7830/v1/contact-channels/ch_1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "revoked", reason: "user request" }),
      }),
      "ch_1",
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.contact.id).toBe("ct_mock");
    expect(contactStoreUpdateChannelMock).toHaveBeenCalledTimes(1);
    const [channelId, params] = contactStoreUpdateChannelMock.mock.calls[0] as [
      string,
      { status?: string; reason?: string },
    ];
    expect(channelId).toBe("ch_1");
    expect(params.status).toBe("revoked");
    expect(params.reason).toBe("user request");
    expect(contactStoreDualWriteChannelMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("updates channel policy natively", async () => {
    contactStoreUpdateChannelMock = mock(() => ({
      ...MOCK_CHANNEL,
      policy: "deny",
    }));
    contactStoreGetMock = mock(async () => DEFAULT_MOCK_CONTACT);

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleUpdateContactChannel(
      new Request("http://localhost:7830/v1/contact-channels/ch_1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ policy: "deny" }),
      }),
      "ch_1",
    );

    expect(res.status).toBe(200);
    expect(contactStoreUpdateChannelMock).toHaveBeenCalledTimes(1);
  });

  test("returns 400 for invalid status", async () => {
    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleUpdateContactChannel(
      new Request("http://localhost:7830/v1/contact-channels/ch_1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "deleted" }),
      }),
      "ch_1",
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toMatch(/status/);
    expect(contactStoreUpdateChannelMock).not.toHaveBeenCalled();
  });

  test("returns 400 for invalid policy", async () => {
    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleUpdateContactChannel(
      new Request("http://localhost:7830/v1/contact-channels/ch_1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ policy: "maybe" }),
      }),
      "ch_1",
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toMatch(/policy/);
  });

  test("returns 400 when neither status nor policy provided", async () => {
    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleUpdateContactChannel(
      new Request("http://localhost:7830/v1/contact-channels/ch_1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "no status or policy" }),
      }),
      "ch_1",
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toMatch(/status or policy/);
  });

  test("returns 400 for invalid JSON body", async () => {
    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleUpdateContactChannel(
      new Request("http://localhost:7830/v1/contact-channels/ch_1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: "not json",
      }),
      "ch_1",
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  test("returns 404 when channel not found", async () => {
    contactStoreUpdateChannelMock = mock(() => null);

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleUpdateContactChannel(
      new Request("http://localhost:7830/v1/contact-channels/nope", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "revoked" }),
      }),
      "nope",
    );

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  test("returns 409 when revoking a blocked channel", async () => {
    const { CannotRevokeBlockedError } = await import("../db/contact-store.js");
    contactStoreUpdateChannelMock = mock(() => {
      throw new CannotRevokeBlockedError("ch_1");
    });

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleUpdateContactChannel(
      new Request("http://localhost:7830/v1/contact-channels/ch_1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "revoked" }),
      }),
      "ch_1",
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("CONFLICT");
    expect(body.error.message).toMatch(/blocked/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("returns 500 on unexpected gateway error (no proxy fallback)", async () => {
    contactStoreUpdateChannelMock = mock(() => {
      throw new Error("gateway DB unavailable");
    });

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleUpdateContactChannel(
      new Request("http://localhost:7830/v1/contact-channels/ch_1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "revoked" }),
      }),
      "ch_1",
    );

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("continues even if assistant DB dual-write fails", async () => {
    contactStoreUpdateChannelMock = mock(() => ({
      ...MOCK_CHANNEL,
      status: "blocked",
    }));
    contactStoreDualWriteChannelMock = mock(async () => {
      throw new Error("assistant DB down");
    });
    contactStoreGetMock = mock(async () => DEFAULT_MOCK_CONTACT);

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleUpdateContactChannel(
      new Request("http://localhost:7830/v1/contact-channels/ch_1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "blocked", reason: "spam" }),
      }),
      "ch_1",
    );

    // Should still succeed — dual-write is best-effort.
    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("resolves assistant-side channel ID to gateway channel (backward compat)", async () => {
    // Simulate: store.updateChannelStatus gets an assistant-side ID that
    // doesn't exist in the gateway DB. The real method resolves it via
    // assistantDbQuery. Here we mock the store to return the resolved
    // channel, confirming the handler correctly awaits the async call
    // and returns 200 (not 404).
    contactStoreUpdateChannelMock = mock(() => ({
      ...MOCK_CHANNEL,
      status: "revoked",
    }));
    contactStoreGetMock = mock(async () => ({
      ...DEFAULT_MOCK_CONTACT,
      id: "ct_mock",
    }));

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleUpdateContactChannel(
      new Request("http://localhost:7830/v1/contact-channels/asst-side-id", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "revoked" }),
      }),
      "asst-side-id",
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.contact.id).toBe("ct_mock");
  });
});
describe("handleMergeContacts (gateway-native)", () => {
  test("merges contacts natively and returns survivor", async () => {
    contactStoreMergeMock = mock(async () => ({
      ...DEFAULT_MOCK_CONTACT,
      id: "ct_keep",
    }));

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleMergeContacts(
      new Request("http://localhost:7830/v1/contacts/merge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keepId: "ct_keep", mergeId: "ct_merge" }),
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.contact.id).toBe("ct_keep");
    expect(contactStoreMergeMock).toHaveBeenCalledTimes(1);
    expect(contactStoreMergeMock.mock.calls[0][0]).toBe("ct_keep");
    expect(contactStoreMergeMock.mock.calls[0][1]).toBe("ct_merge");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("returns 400 when keepId is missing", async () => {
    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleMergeContacts(
      new Request("http://localhost:7830/v1/contacts/merge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mergeId: "ct_merge" }),
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toMatch(/keepId and mergeId/);
    expect(contactStoreMergeMock).not.toHaveBeenCalled();
  });

  test("returns 400 when mergeId is missing", async () => {
    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleMergeContacts(
      new Request("http://localhost:7830/v1/contacts/merge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keepId: "ct_keep" }),
      }),
    );

    expect(res.status).toBe(400);
    expect(contactStoreMergeMock).not.toHaveBeenCalled();
  });

  test("returns 400 for self-merge", async () => {
    const { MergeContactsError } = await import("../db/contact-store.js");
    contactStoreMergeMock = mock(async () => {
      throw new MergeContactsError("Cannot merge a contact with itself");
    });

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleMergeContacts(
      new Request("http://localhost:7830/v1/contacts/merge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keepId: "ct_1", mergeId: "ct_1" }),
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toMatch(/self/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("returns 400 when contact not found", async () => {
    const { MergeContactsError } = await import("../db/contact-store.js");
    contactStoreMergeMock = mock(async () => {
      throw new MergeContactsError('Contact "ct_x" not found');
    });

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleMergeContacts(
      new Request("http://localhost:7830/v1/contacts/merge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keepId: "ct_keep", mergeId: "ct_x" }),
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toMatch(/not found/);
  });

  test("returns 400 for invalid JSON body", async () => {
    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleMergeContacts(
      new Request("http://localhost:7830/v1/contacts/merge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  test("returns 500 on unexpected error (no proxy fallback)", async () => {
    contactStoreMergeMock = mock(async () => {
      throw new Error("gateway DB unavailable");
    });

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleMergeContacts(
      new Request("http://localhost:7830/v1/contacts/merge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keepId: "ct_keep", mergeId: "ct_merge" }),
      }),
    );

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("returns 200 even if store returns null (survivor read-back miss)", async () => {
    contactStoreMergeMock = mock(async () => null);

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleMergeContacts(
      new Request("http://localhost:7830/v1/contacts/merge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keepId: "ct_keep", mergeId: "ct_merge" }),
      }),
    );

    // The merge itself succeeded (no throw); the survivor read-back just
    // returned null. Still 200 with ok:true.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.contact).toBeUndefined();
  });
});

  test("returns 400 when merging away a guardian contact", async () => {
    const { MergeContactsError } = await import("../db/contact-store.js");
    contactStoreMergeMock = mock(async () => {
      throw new MergeContactsError(
        "Cannot merge away a guardian contact. Keep the guardian as the survivor instead.",
      );
    });

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleMergeContacts(
      new Request("http://localhost:7830/v1/contacts/merge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keepId: "ct_regular", mergeId: "ct_guardian" }),
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toMatch(/guardian/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

describe("handleCreateInvite (gateway-native)", () => {
  test("mints, writes gateway DB, and returns 201 with rawToken", async () => {
    const mintInvite = { id: "inv_1", sourceChannel: "telegram" };
    ipcCallAssistantMock = mock(async (method: string) => {
      if (method === "invites_mint") {
        return {
          ok: true,
          invite: mintInvite,
          rawToken: "raw-token-abc",
          gateway: {
            id: "inv_1",
            inviteCodeHash: "hash_1",
            sourceChannel: "telegram",
            contactId: "ct_1",
            note: null,
            maxUses: 1,
            expiresAt: 2000000,
          },
        };
      }
      return {};
    });
    contactStoreCreateInviteMock = mock(() => DEFAULT_INVITE);

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleCreateInvite(
      new Request("http://localhost:7830/v1/contacts/invites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contactId: "ct_1", sourceChannel: "telegram" }),
      }),
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.rawToken).toBe("raw-token-abc");
    expect(body.invite.id).toBe("inv_1");
    expect(contactStoreCreateInviteMock).toHaveBeenCalledTimes(1);
    const [createParams] = contactStoreCreateInviteMock.mock.calls[0] as [
      Record<string, unknown>,
    ];
    expect(createParams.id).toBe("inv_1");
    expect(createParams.inviteCodeHash).toBe("hash_1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("returns 400 for invalid JSON body", async () => {
    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleCreateInvite(
      new Request("http://localhost:7830/v1/contacts/invites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      }),
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("BAD_REQUEST");
    expect(contactStoreCreateInviteMock).not.toHaveBeenCalled();
  });

  test("returns 400 when sourceChannel is missing", async () => {
    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleCreateInvite(
      new Request("http://localhost:7830/v1/contacts/invites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contactId: "ct_1" }),
      }),
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/sourceChannel/);
    expect(ipcCallAssistantMock).not.toHaveBeenCalled();
  });

  test("returns 404 when contact does not exist", async () => {
    contactStoreGetContactMock = mock(() => undefined);

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleCreateInvite(
      new Request("http://localhost:7830/v1/contacts/invites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contactId: "ct_missing", sourceChannel: "telegram" }),
      }),
    );

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
    expect(ipcCallAssistantMock).not.toHaveBeenCalled();
  });

  test("returns 500 when gateway DB write fails (no proxy fallback)", async () => {
    ipcCallAssistantMock = mock(async (method: string) => {
      if (method === "invites_mint") {
        return {
          ok: true,
          invite: { id: "inv_1" },
          rawToken: "raw",
          gateway: {
            id: "inv_1",
            inviteCodeHash: "hash_1",
            sourceChannel: "telegram",
            contactId: "ct_1",
            note: null,
            maxUses: 1,
            expiresAt: 2000000,
          },
        };
      }
      return {};
    });
    contactStoreCreateInviteMock = mock(() => {
      throw new Error("gateway DB unavailable");
    });

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleCreateInvite(
      new Request("http://localhost:7830/v1/contacts/invites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contactId: "ct_1", sourceChannel: "telegram" }),
      }),
    );

    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("INTERNAL_ERROR");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("maps assistant mint 400 (IpcHandlerError) to a 400 response", async () => {
    ipcCallAssistantMock = mock(async (method: string) => {
      if (method === "invites_mint") {
        throw new IpcHandlerError(
          "expectedExternalUserId is required for voice invites",
          400,
          "BAD_REQUEST",
        );
      }
      return {};
    });

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleCreateInvite(
      new Request("http://localhost:7830/v1/contacts/invites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contactId: "ct_1", sourceChannel: "phone" }),
      }),
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/expectedExternalUserId/);
    expect(contactStoreCreateInviteMock).not.toHaveBeenCalled();
  });
});

describe("handleListInvites (gateway-native)", () => {
  test("returns gateway rows joined with assistant voice fields", async () => {
    contactStoreListInvitesMock = mock(() => [
      { ...DEFAULT_INVITE, id: "inv_1", sourceChannel: "phone" },
    ]);
    assistantDbQueryMock = mock(async () => [
      {
        id: "inv_1",
        voiceCodeDigits: 6,
        friendName: "Alice",
        guardianName: "Bob",
        expectedExternalUserId: "+15551234567",
      },
    ]);

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleListInvites(
      new Request("http://localhost:7830/v1/contacts/invites?status=active"),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.invites).toHaveLength(1);
    expect(body.invites[0].id).toBe("inv_1");
    expect(body.invites[0].voiceCodeDigits).toBe(6);
    expect(body.invites[0].friendName).toBe("Alice");
    // status filter passed through to the store query.
    expect(contactStoreListInvitesMock.mock.calls[0][0]).toEqual({
      status: "active",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("degrades gracefully when the assistant voice-field join throws", async () => {
    contactStoreListInvitesMock = mock(() => [
      { ...DEFAULT_INVITE, id: "inv_1" },
    ]);
    assistantDbQueryMock = mock(async () => {
      throw new Error("assistant DB down");
    });

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleListInvites(
      new Request("http://localhost:7830/v1/contacts/invites"),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.invites).toHaveLength(1);
    expect(body.invites[0].id).toBe("inv_1");
    expect(body.invites[0].friendName).toBeUndefined();
  });

  test("returns 500 when the gateway read throws", async () => {
    contactStoreListInvitesMock = mock(() => {
      throw new Error("gateway DB unavailable");
    });

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleListInvites(
      new Request("http://localhost:7830/v1/contacts/invites"),
    );

    expect(res.status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("handleRevokeInvite (gateway-native)", () => {
  test("revokes the invite and mirrors into the assistant DB", async () => {
    contactStoreRevokeInviteMock = mock(() => ({
      ...DEFAULT_INVITE,
      status: "revoked",
    }));

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleRevokeInvite(
      new Request("http://localhost:7830/v1/contacts/invites/inv_1", {
        method: "DELETE",
      }),
      "inv_1",
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.invite.status).toBe("revoked");
    expect(contactStoreRevokeInviteMock).toHaveBeenCalledWith("inv_1");
    // Best-effort assistant DB mirror.
    expect(assistantDbRunMock).toHaveBeenCalledTimes(1);
    expect(assistantDbRunMock.mock.calls[0][0]).toMatch(
      /assistant_ingress_invites/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("returns 404 for an unknown invite id", async () => {
    contactStoreRevokeInviteMock = mock(() => null);

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleRevokeInvite(
      new Request("http://localhost:7830/v1/contacts/invites/nope", {
        method: "DELETE",
      }),
      "nope",
    );

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
    expect(assistantDbRunMock).not.toHaveBeenCalled();
  });

  test("still succeeds when the assistant DB mirror soft-fails", async () => {
    contactStoreRevokeInviteMock = mock(() => ({
      ...DEFAULT_INVITE,
      status: "revoked",
    }));
    assistantDbRunMock = mock(async () => {
      throw new Error("assistant DB down");
    });

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleRevokeInvite(
      new Request("http://localhost:7830/v1/contacts/invites/inv_1", {
        method: "DELETE",
      }),
      "inv_1",
    );

    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("returns 500 on unexpected gateway error (no proxy fallback)", async () => {
    contactStoreRevokeInviteMock = mock(() => {
      throw new Error("gateway DB unavailable");
    });

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleRevokeInvite(
      new Request("http://localhost:7830/v1/contacts/invites/inv_1", {
        method: "DELETE",
      }),
      "inv_1",
    );

    expect(res.status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("handleRedeemInvite (gateway-native)", () => {
  test("voice path relays to invites_redeem_voice and mirrors redemption", async () => {
    ipcCallAssistantMock = mock(async (method: string) => {
      if (method === "invites_redeem_voice") {
        return { type: "redeemed", memberId: "mem_1", inviteId: "inv_1" };
      }
      return {};
    });

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleRedeemInvite(
      new Request("http://localhost:7830/v1/contacts/invites/redeem", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code: "123456",
          callerExternalUserId: "+15551234567",
        }),
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.type).toBe("redeemed");
    expect(body.memberId).toBe("mem_1");
    expect(body.inviteId).toBe("inv_1");
    // Voice path called, not token path.
    expect(ipcCallAssistantMock.mock.calls[0][0]).toBe("invites_redeem_voice");
    expect(contactStoreRecordRedemptionMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("voice already_member (no inviteId) skips the gateway mirror", async () => {
    ipcCallAssistantMock = mock(async (method: string) => {
      if (method === "invites_redeem_voice") {
        return { type: "already_member", memberId: "mem_1" };
      }
      return {};
    });

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleRedeemInvite(
      new Request("http://localhost:7830/v1/contacts/invites/redeem", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code: "123456",
          callerExternalUserId: "+15551234567",
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect((await res.json()).type).toBe("already_member");
    expect(contactStoreRecordRedemptionMock).not.toHaveBeenCalled();
  });

  test("token path relays to invites_redeem_token and mirrors redemption", async () => {
    ipcCallAssistantMock = mock(async (method: string) => {
      if (method === "invites_redeem_token") {
        return { invite: { id: "inv_1", status: "redeemed" } };
      }
      return {};
    });

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleRedeemInvite(
      new Request("http://localhost:7830/v1/contacts/invites/redeem", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: "tok-abc",
          sourceChannel: "telegram",
          externalUserId: "u_1",
        }),
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.invite.id).toBe("inv_1");
    expect(ipcCallAssistantMock.mock.calls[0][0]).toBe("invites_redeem_token");
    expect(contactStoreRecordRedemptionMock).toHaveBeenCalledTimes(1);
    const [params] = contactStoreRecordRedemptionMock.mock.calls[0] as [
      Record<string, unknown>,
    ];
    expect(params.inviteId).toBe("inv_1");
    expect(params.redeemedByExternalUserId).toBe("u_1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("returns 400 for invalid JSON body", async () => {
    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleRedeemInvite(
      new Request("http://localhost:7830/v1/contacts/invites/redeem", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      }),
    );

    expect(res.status).toBe(400);
    expect(ipcCallAssistantMock).not.toHaveBeenCalled();
  });

  test("returns 400 when token redeem is missing sourceChannel", async () => {
    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleRedeemInvite(
      new Request("http://localhost:7830/v1/contacts/invites/redeem", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "tok" }),
      }),
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/sourceChannel/);
    expect(ipcCallAssistantMock).not.toHaveBeenCalled();
  });

  test("still succeeds when the gateway redemption mirror soft-fails", async () => {
    ipcCallAssistantMock = mock(async (method: string) => {
      if (method === "invites_redeem_token") {
        return { invite: { id: "inv_1" } };
      }
      return {};
    });
    contactStoreRecordRedemptionMock = mock(() => {
      throw new Error("gateway DB down");
    });

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleRedeemInvite(
      new Request("http://localhost:7830/v1/contacts/invites/redeem", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "tok", sourceChannel: "telegram" }),
      }),
    );

    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("maps assistant redeem 400 (IpcHandlerError) to 400", async () => {
    ipcCallAssistantMock = mock(async (method: string) => {
      if (method === "invites_redeem_token") {
        throw new IpcHandlerError("Invite not found", 400, "BAD_REQUEST");
      }
      return {};
    });

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleRedeemInvite(
      new Request("http://localhost:7830/v1/contacts/invites/redeem", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "tok", sourceChannel: "telegram" }),
      }),
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/not found/);
  });
});

describe("handleCallInvite (gateway-native)", () => {
  test("relays the call for an active invite", async () => {
    contactStoreGetInviteByIdMock = mock(() => ({
      ...DEFAULT_INVITE,
      status: "active",
    }));
    ipcCallAssistantMock = mock(async (method: string) => {
      if (method === "invites_trigger_call") {
        return { callSid: "CA123" };
      }
      return {};
    });

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleCallInvite(
      new Request("http://localhost:7830/v1/contacts/invites/inv_1/call", {
        method: "POST",
      }),
      "inv_1",
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.callSid).toBe("CA123");
    expect(ipcCallAssistantMock.mock.calls[0]).toEqual([
      "invites_trigger_call",
      { body: { id: "inv_1" } },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("returns 404 when the invite does not exist", async () => {
    contactStoreGetInviteByIdMock = mock(() => null);

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleCallInvite(
      new Request("http://localhost:7830/v1/contacts/invites/nope/call", {
        method: "POST",
      }),
      "nope",
    );

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
    expect(ipcCallAssistantMock).not.toHaveBeenCalled();
  });

  test("returns 400 when the invite is not active", async () => {
    contactStoreGetInviteByIdMock = mock(() => ({
      ...DEFAULT_INVITE,
      status: "revoked",
    }));

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleCallInvite(
      new Request("http://localhost:7830/v1/contacts/invites/inv_1/call", {
        method: "POST",
      }),
      "inv_1",
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/not active/);
    expect(ipcCallAssistantMock).not.toHaveBeenCalled();
  });

  test("returns 500 when the call relay throws unexpectedly", async () => {
    contactStoreGetInviteByIdMock = mock(() => ({
      ...DEFAULT_INVITE,
      status: "active",
    }));
    ipcCallAssistantMock = mock(async () => {
      throw new Error("ipc transport failure");
    });

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleCallInvite(
      new Request("http://localhost:7830/v1/contacts/invites/inv_1/call", {
        method: "POST",
      }),
      "inv_1",
    );

    expect(res.status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

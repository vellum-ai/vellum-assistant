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

type DbRunFn = (sql: string, bind?: unknown[]) => Promise<void>;
let assistantDbRunMock: ReturnType<typeof mock<DbRunFn>> = mock(async () => {});

mock.module("../db/assistant-db-proxy.js", () => ({
  assistantDbQuery: (...args: Parameters<DbQueryFn>) => assistantDbQueryMock(...args),
  assistantDbRun: (...args: Parameters<DbRunFn>) => assistantDbRunMock(...args),
}));

// ── IPC assistant client mock ─────────────────────────────────────────────────
type IpcCallFn = (method: string, params: unknown) => Promise<unknown>;
let ipcCallAssistantMock: ReturnType<typeof mock<IpcCallFn>> = mock(async () => ({}));

mock.module("../ipc/assistant-client.js", () => ({
  ipcCallAssistant: (...args: Parameters<IpcCallFn>) => ipcCallAssistantMock(...args),
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
  contactType?: string;
}) => Promise<typeof DEFAULT_MOCK_CONTACT[]>;
let contactStoreListMock: ReturnType<typeof mock<ListFn>> = mock(async () => []);

type GetFn = (contactId: string) => Promise<typeof DEFAULT_MOCK_CONTACT | null>;
let contactStoreGetMock: ReturnType<typeof mock<GetFn>> = mock(async () => null);

mock.module("../db/contact-store.js", () => ({
  ContactStore: class MockContactStore {
    upsertContact(...args: Parameters<UpsertFn>) {
      return contactStoreUpsertMock(...args);
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
  assistantDbRunMock = mock(async () => {});
  ipcCallAssistantMock = mock(async () => ({}));
  contactStoreUpsertMock = mock(async () => ({
    contact: DEFAULT_MOCK_CONTACT,
    created: false,
  }));
  contactStoreListMock = mock(async () => []);
  contactStoreGetMock = mock(async () => null);
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
    await handler.handleMergeContacts(
      new Request("http://localhost:7830/v1/contacts/merge", {
        method: "POST",
      }),
    );
    await handler.handleUpdateContactChannel(
      new Request("http://localhost:7830/v1/contact-channels/ch_1", {
        method: "PATCH",
      }),
      "ch_1",
    );

    expect(captured).toEqual([
      "http://localhost:7821/v1/contacts?limit=10&query=alice",
      "http://localhost:7821/v1/contacts/ct_1",
      "http://localhost:7821/v1/contacts/merge",
      "http://localhost:7821/v1/contact-channels/ch_1",
    ]);
  });

  test("forwards invite endpoints to the runtime", async () => {
    const captured: string[] = [];
    fetchMock = mock(async (input: string | URL | Request) => {
      captured.push(String(input));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const handler = createContactsControlPlaneProxyHandler(makeConfig());

    await handler.handleListInvites(
      new Request("http://localhost:7830/v1/contacts/invites?status=active"),
    );
    await handler.handleCreateInvite(
      new Request("http://localhost:7830/v1/contacts/invites", {
        method: "POST",
      }),
    );
    await handler.handleRedeemInvite(
      new Request("http://localhost:7830/v1/contacts/invites/redeem", {
        method: "POST",
      }),
    );
    await handler.handleRevokeInvite(
      new Request("http://localhost:7830/v1/contacts/invites/inv_123", {
        method: "DELETE",
      }),
      "inv_123",
    );

    expect(captured).toEqual([
      "http://localhost:7821/v1/contacts/invites?status=active",
      "http://localhost:7821/v1/contacts/invites",
      "http://localhost:7821/v1/contacts/invites/redeem",
      "http://localhost:7821/v1/contacts/invites/inv_123",
    ]);
  });

  test("replaces caller auth with runtime auth", async () => {
    let capturedHeaders: Headers | undefined;
    fetchMock = mock(
      async (_input: string | URL | Request, init?: RequestInit) => {
        capturedHeaders = init?.headers as unknown as Headers;
        return new Response("ok", { status: 200 });
      },
    );

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleCreateInvite(
      new Request("http://localhost:7830/v1/contacts/invites", {
        method: "POST",
        headers: {
          authorization: "Bearer caller-token",
          host: "localhost:7830",
        },
        body: JSON.stringify({
          sourceChannel: "telegram",
          externalUserId: "u_1",
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect(capturedHeaders?.get("authorization")).toMatch(/^Bearer ey/);
    expect(capturedHeaders?.has("host")).toBe(false);
  });

  test("passes through upstream client errors", async () => {
    fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({ ok: false, error: "sourceChannel is required" }),
        {
          status: 400,
          headers: { "content-type": "application/json" },
        },
      );
    });

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    const res = await handler.handleCreateInvite(
      new Request("http://localhost:7830/v1/contacts/invites", {
        method: "POST",
      }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      ok: false,
      error: "sourceChannel is required",
    });
  });

  test("returns 504 when upstream times out", async () => {
    fetchMock = mock(async () => {
      throw new DOMException(
        "The operation was aborted due to timeout",
        "TimeoutError",
      );
    });

    const handler = createContactsControlPlaneProxyHandler(
      makeConfig({ runtimeTimeoutMs: 100 }),
    );
    const res = await handler.handleListInvites(
      new Request("http://localhost:7830/v1/contacts/invites"),
    );

    expect(res.status).toBe(504);
    expect(await res.json()).toEqual({ error: "Gateway Timeout" });
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

  test("passes limit, role, contactType filters to store", async () => {
    contactStoreListMock = mock(async () => []);

    const handler = createContactsControlPlaneProxyHandler(makeConfig());
    await handler.handleListContacts(
      new Request(
        "http://localhost:7830/v1/contacts?limit=10&role=guardian&contactType=human",
      ),
    );

    expect(contactStoreListMock).toHaveBeenCalledTimes(1);
    const opts = contactStoreListMock.mock.calls[0][0] as {
      limit?: number;
      role?: string;
      contactType?: string;
    };
    expect(opts.limit).toBe(10);
    expect(opts.role).toBe("guardian");
    expect(opts.contactType).toBe("human");
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

  test("includes assistantMetadata for assistant contactType", async () => {
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

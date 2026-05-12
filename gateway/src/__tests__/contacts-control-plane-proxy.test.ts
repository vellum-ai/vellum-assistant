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

mock.module("../db/contact-store.js", () => ({
  ContactStore: class MockContactStore {
    upsertContact(...args: Parameters<UpsertFn>) {
      return contactStoreUpsertMock(...args);
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

    await handler.handleListContacts(
      new Request("http://localhost:7830/v1/contacts?limit=10"),
    );
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
      "http://localhost:7821/v1/contacts?limit=10",
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
    const res = await handler.handleListContacts(
      new Request("http://localhost:7830/v1/contacts"),
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
      new Request("http://localhost:7830/v1/contacts"),
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
      new Request("http://localhost:7830/v1/contacts"),
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

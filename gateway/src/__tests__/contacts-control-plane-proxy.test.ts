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

const { createContactsControlPlaneProxyHandler } =
  await import("../http/routes/contacts-control-plane-proxy.js");

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const merged: GatewayConfig = {
    assistantRuntimeBaseUrl: "http://localhost:7821",
    routingEntries: [],
    defaultAssistantId: undefined,
    unmappedPolicy: "reject",
    port: 7830,
    runtimeProxyEnabled: false,
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
    await handler.handleUpsertContact(
      new Request("http://localhost:7830/v1/contacts", { method: "POST" }),
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
      "http://localhost:7821/v1/contacts",
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
});

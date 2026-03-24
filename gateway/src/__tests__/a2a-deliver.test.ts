import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { GatewayConfig } from "../config.js";
import type { ConfigFileCache } from "../config-file-cache.js";
import type { CredentialCache } from "../credential-cache.js";

type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
let fetchMock: ReturnType<typeof mock<FetchFn>> = mock(
  async () => new Response(JSON.stringify({ ok: true })),
);

mock.module("../fetch.js", () => ({
  fetchImpl: (...args: Parameters<FetchFn>) => fetchMock(...args),
}));

mock.module("../auth/token-exchange.js", () => ({
  mintIngressToken: () => "mock-ingress-token",
  mintServiceToken: () => "mock-service-token",
  mintExchangeToken: () => "mock-exchange-token",
  mintBrowserRelayToken: () => "mock-browser-relay-token",
  validateEdgeToken: () => ({ ok: true }),
}));

mock.module("../auth/token-service.js", () => ({
  verifyToken: () => ({ ok: true }),
}));

const { createA2ADeliverHandler } =
  await import("../http/routes/a2a-deliver.js");

// ── Helpers ──

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    assistantRuntimeBaseUrl: "http://localhost:7821",
    defaultAssistantId: "local-assistant",
    gatewayInternalBaseUrl: "http://127.0.0.1:7830",
    logFile: { dir: undefined, retentionDays: 30 },
    maxAttachmentBytes: {
      telegram: 50 * 1024 * 1024,
      slack: 100 * 1024 * 1024,
      whatsapp: 16 * 1024 * 1024,
      default: 50 * 1024 * 1024,
    },
    maxAttachmentConcurrency: 3,
    maxWebhookPayloadBytes: 1048576,
    port: 7830,
    routingEntries: [],
    runtimeInitialBackoffMs: 500,
    runtimeMaxRetries: 2,
    runtimeProxyEnabled: false,
    runtimeProxyRequireAuth: false,
    runtimeTimeoutMs: 30000,
    shutdownDrainMs: 5000,
    unmappedPolicy: "reject",
    trustProxy: false,
    ...overrides,
  } as GatewayConfig;
}

function makeConfigFile(
  overrides: Record<string, Record<string, string | number | boolean>> = {},
): ConfigFileCache {
  const data: Record<string, Record<string, string | number | boolean>> = {
    a2a: { deliverAuthBypass: true },
    ...overrides,
  };
  return {
    getString: (section: string, key: string) =>
      data[section]?.[key] as string | undefined,
    getNumber: (section: string, key: string) =>
      data[section]?.[key] as number | undefined,
    getBoolean: (section: string, key: string) =>
      data[section]?.[key] as boolean | undefined,
    getRecord: () => undefined,
    refreshNow: () => {},
    invalidate: () => {},
  } as unknown as ConfigFileCache;
}

function makeCredentialCache(
  entries: Record<string, string> = {},
): CredentialCache {
  return {
    get: mock(async (key: string) => entries[key]),
    refreshNow: mock(async () => {}),
    invalidate: mock(() => {}),
    onInvalidate: mock(() => () => {}),
  } as unknown as CredentialCache;
}

function makeCaches(entries: Record<string, string> = {}): {
  credentials: CredentialCache;
  configFile: ConfigFileCache;
} {
  return {
    credentials: makeCredentialCache(entries),
    configFile: makeConfigFile(),
  };
}

function makeRequest(
  body: unknown,
  queryParams: Record<string, string> = {},
): Request {
  const url = new URL("http://gateway.test/deliver/a2a");
  for (const [k, v] of Object.entries(queryParams)) {
    url.searchParams.set(k, v);
  }
  return new Request(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer mock-daemon-token",
    },
    body: JSON.stringify(body),
  });
}

describe("POST /deliver/a2a", () => {
  beforeEach(() => {
    fetchMock = mock(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
  });

  test("reads gatewayUrl and assistantId from query params, resolves outbound token, posts envelope", async () => {
    const caches = makeCaches({
      "a2a:outbound:bob": "outbound-token-for-bob",
    });
    const handler = createA2ADeliverHandler(makeConfig(), caches);

    const res = await handler(
      makeRequest(
        { chatId: "bob", text: "hello bob" },
        {
          gatewayUrl: "http://bob-gateway.test",
          assistantId: "bob",
        },
      ),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // Verify the outbound fetch
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://bob-gateway.test/webhook/a2a");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer outbound-token-for-bob",
    );

    const sentBody = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sentBody.version).toBe("v1");
    expect(sentBody.type).toBe("message");
    expect(sentBody.content).toBe("hello bob");
    expect(sentBody.senderAssistantId).toBe("local-assistant");
  });

  test("returns 502 when outbound token is missing", async () => {
    const caches = makeCaches({}); // no token
    const handler = createA2ADeliverHandler(makeConfig(), caches);

    const res = await handler(
      makeRequest(
        { chatId: "bob", text: "hello" },
        {
          gatewayUrl: "http://bob-gateway.test",
          assistantId: "bob",
        },
      ),
    );

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("Outbound token not found");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("allows unauthenticated send when allowUnauthenticated=true query param is set", async () => {
    const caches = makeCaches({}); // no token
    const handler = createA2ADeliverHandler(makeConfig(), caches);

    const url = new URL("http://gateway.test/deliver/a2a");
    url.searchParams.set("gatewayUrl", "http://bob-gateway.test");
    url.searchParams.set("assistantId", "bob");
    url.searchParams.set("allowUnauthenticated", "true");

    const req = new Request(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer mock-daemon-token",
      },
      body: JSON.stringify({ text: "pairing response" }),
    });

    const res = await handler(req);
    expect(res.status).toBe(200);

    // Should have made the outbound fetch without Authorization header
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(
      (init.headers as Record<string, string>)["Authorization"],
    ).toBeUndefined();
  });

  test("returns 502 when target gateway is unreachable", async () => {
    fetchMock = mock(async () => {
      throw new Error("ECONNREFUSED");
    });
    const caches = makeCaches({
      "a2a:outbound:bob": "token",
    });
    const handler = createA2ADeliverHandler(makeConfig(), caches);

    const res = await handler(
      makeRequest(
        { text: "hello" },
        {
          gatewayUrl: "http://bob-gateway.test",
          assistantId: "bob",
        },
      ),
    );

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.userMessage).toContain("unreachable");
  });

  test("returns 502 when target gateway returns error", async () => {
    fetchMock = mock(
      async () =>
        new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
        }),
    );
    const caches = makeCaches({
      "a2a:outbound:bob": "token",
    });
    const handler = createA2ADeliverHandler(makeConfig(), caches);

    const res = await handler(
      makeRequest(
        { text: "hello" },
        {
          gatewayUrl: "http://bob-gateway.test",
          assistantId: "bob",
        },
      ),
    );

    expect(res.status).toBe(502);
  });

  test("returns 400 when gatewayUrl query param is missing", async () => {
    const handler = createA2ADeliverHandler(makeConfig(), makeCaches());

    const res = await handler(
      makeRequest({ text: "hello" }, { assistantId: "bob" }),
    );

    expect(res.status).toBe(400);
  });

  test("returns 400 when text is missing", async () => {
    const handler = createA2ADeliverHandler(makeConfig(), makeCaches());

    const res = await handler(
      makeRequest(
        { chatId: "bob" },
        {
          gatewayUrl: "http://bob-gateway.test",
          assistantId: "bob",
        },
      ),
    );

    expect(res.status).toBe(400);
  });
});

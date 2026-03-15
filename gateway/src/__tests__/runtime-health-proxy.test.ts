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

const { createRuntimeHealthProxyHandler } =
  await import("../http/routes/runtime-health-proxy.js");

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

describe("runtime health proxy", () => {
  test("forwards to runtime /v1/health", async () => {
    const captured: string[] = [];
    fetchMock = mock(async (input: string | URL | Request) => {
      captured.push(String(input));
      return new Response(JSON.stringify({ status: "healthy" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const handler = createRuntimeHealthProxyHandler(makeConfig());
    const res = await handler.handleRuntimeHealth(
      new Request("http://localhost:7830/v1/health"),
    );

    expect(res.status).toBe(200);
    expect(captured).toEqual(["http://localhost:7821/v1/health"]);
    expect(await res.json()).toEqual({ status: "healthy" });
  });

  test("replaces caller auth with runtime auth", async () => {
    let capturedHeaders: Headers | undefined;
    fetchMock = mock(
      async (_input: string | URL | Request, init?: RequestInit) => {
        capturedHeaders = init?.headers as unknown as Headers;
        return new Response("ok", { status: 200 });
      },
    );

    const handler = createRuntimeHealthProxyHandler(makeConfig());
    const res = await handler.handleRuntimeHealth(
      new Request("http://localhost:7830/v1/health", {
        headers: {
          authorization: "Bearer caller-token",
          host: "localhost:7830",
        },
      }),
    );

    expect(res.status).toBe(200);
    expect(capturedHeaders?.get("authorization")).toMatch(/^Bearer ey/);
    expect(capturedHeaders?.has("host")).toBe(false);
  });

  test("returns 504 on timeout", async () => {
    fetchMock = mock(async () => {
      throw new DOMException(
        "The operation was aborted due to timeout",
        "TimeoutError",
      );
    });

    const handler = createRuntimeHealthProxyHandler(
      makeConfig({ runtimeTimeoutMs: 100 }),
    );
    const res = await handler.handleRuntimeHealth(
      new Request("http://localhost:7830/v1/health"),
    );

    expect(res.status).toBe(504);
    expect(await res.json()).toEqual({ error: "Gateway Timeout" });
  });
});

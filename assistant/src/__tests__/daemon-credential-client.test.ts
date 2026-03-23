import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { credentialKey } from "../security/credential-key.js";

let fallbackValues = new Map<string, string>();

mock.module("../config/env.js", () => ({
  getRuntimeHttpHost: () => "127.0.0.1",
  getRuntimeHttpPort: () => 4123,
}));

mock.module("../daemon/daemon-control.js", () => ({
  healthCheckHost: (host: string) => host,
  isHttpHealthy: async () => true,
}));

mock.module("../runtime/auth/token-service.js", () => ({
  initAuthSigningKey: () => {},
  loadOrCreateSigningKey: () => "signing-key",
  mintDaemonDeliveryToken: () => "daemon-token",
}));

mock.module("../security/secure-keys.js", () => ({
  deleteSecureKeyAsync: async () => "deleted" as const,
  getSecureKeyAsync: async (account: string) => fallbackValues.get(account),
  getSecureKeyResultAsync: async (account: string) => ({
    value: fallbackValues.get(account),
    unreachable: false,
  }),
  setSecureKeyAsync: async () => true,
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import {
  getSecureKeyResultViaDaemon,
  getSecureKeyViaDaemon,
} from "../cli/lib/daemon-credential-client.js";

const originalFetch = globalThis.fetch;
const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];

function getRequestBody(index = 0): Record<string, unknown> {
  const body = fetchCalls[index]?.init?.body;
  if (typeof body !== "string") {
    throw new Error("Expected fetch body to be a JSON string");
  }
  return JSON.parse(body) as Record<string, unknown>;
}

beforeEach(() => {
  fallbackValues = new Map();
  fetchCalls.length = 0;
  const mockFetch = mock(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      fetchCalls.push({ url, init });
      return new Response(
        JSON.stringify({ found: true, value: "secret-value" }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    },
  );
  globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("daemon credential read requests", () => {
  test("keeps provider secrets on the api_key path", async () => {
    const value = await getSecureKeyViaDaemon("openai");

    expect(value).toBe("secret-value");
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe("http://127.0.0.1:4123/v1/secrets/read");
    expect(getRequestBody()).toEqual({
      type: "api_key",
      name: "openai",
      reveal: true,
    });
  });

  test("converts canonical credential keys into credential reads", async () => {
    const value = await getSecureKeyViaDaemon(
      credentialKey("vellum", "platform_base_url"),
    );

    expect(value).toBe("secret-value");
    expect(getRequestBody()).toEqual({
      type: "credential",
      name: "vellum:platform_base_url",
      reveal: true,
    });
  });

  test("preserves compound credential service names on metadata reads", async () => {
    const result = await getSecureKeyResultViaDaemon(
      credentialKey("integration:google", "client_secret"),
    );

    expect(result).toEqual({ value: "secret-value", unreachable: false });
    expect(getRequestBody()).toEqual({
      type: "credential",
      name: "integration:google:client_secret",
      reveal: true,
    });
  });
});

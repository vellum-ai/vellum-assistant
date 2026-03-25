import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import type { CesClient } from "../credential-execution/client.js";
import {
  _resetBackend,
  getActiveBackendName,
  getSecureKeyAsync,
  setCesClient,
} from "../security/secure-keys.js";

const rpcCall = mock(async () => ({ found: false }));
const originalFetch = globalThis.fetch;

let rpcReady = true;

function createMockCesClient(): CesClient {
  return {
    handshake: mock(async () => ({ accepted: true })),
    call: rpcCall as CesClient["call"],
    updateAssistantApiKey: mock(async () => ({ updated: true })),
    isReady: () => rpcReady,
    close: mock(() => {}),
  };
}

describe("secure-keys managed CES failover", () => {
  beforeEach(() => {
    _resetBackend();
    rpcCall.mockClear();
    rpcReady = true;
    process.env.IS_CONTAINERIZED = "1";
    process.env.CES_CREDENTIAL_URL = "http://localhost:8090";
    process.env.CES_SERVICE_TOKEN = "test-token";
    const mockFetch = mock(async () => {
      return new Response(JSON.stringify({ value: "http-secret" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    mockFetch.preconnect = originalFetch.preconnect;
    globalThis.fetch = mockFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.IS_CONTAINERIZED;
    delete process.env.CES_CREDENTIAL_URL;
    delete process.env.CES_SERVICE_TOKEN;
    _resetBackend();
  });

  test("falls back from dead CES RPC transport to CES HTTP in managed mode", async () => {
    setCesClient(createMockCesClient());

    expect(await getSecureKeyAsync("openai")).toBeUndefined();
    expect(getActiveBackendName()).toBe("ces-rpc");
    expect(rpcCall).toHaveBeenCalledTimes(1);

    rpcReady = false;

    expect(await getSecureKeyAsync("openai")).toBe("http-secret");
    expect(getActiveBackendName()).toBe("ces-http");
    expect(rpcCall).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});

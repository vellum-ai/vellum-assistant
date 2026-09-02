import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let platformAssistantId = "asst_123";
let fetchImpl: (
  url: string,
  init?: RequestInit,
) => Promise<Response> = async () => new Response("{}", { status: 200 });
const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];

mock.module("../platform/feature-gate.js", () => ({
  arePlatformFeaturesEnabled: () => true,
}));

mock.module("../providers/platform-proxy/context.js", () => ({
  resolveManagedProxyContext: async () => ({
    enabled: true,
    platformBaseUrl: "https://platform.test/",
    assistantApiKey: "assistant-key",
  }),
}));

mock.module("../config/env.js", () => ({
  getPlatformAssistantId: () => platformAssistantId,
}));

mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: async () => null,
}));

const { VellumPlatformClient } = await import("../platform/client.js");

const originalFetch = globalThis.fetch;

beforeEach(() => {
  platformAssistantId = "asst_123";
  fetchCalls.length = 0;
  fetchImpl = async () => new Response("{}", { status: 200 });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    fetchCalls.push({ url, init });
    return fetchImpl(url, init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function createClient() {
  const client = await VellumPlatformClient.create();
  if (!client) {
    throw new Error("client prerequisites were not satisfied");
  }
  return client;
}

describe("VellumPlatformClient.verifyCredential", () => {
  test("an accepted request is a valid credential, asked on the owner-consent carrier with the stored key", async () => {
    const client = await createClient();

    expect(await client.verifyCredential()).toBe("valid");

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe(
      "https://platform.test/v1/assistants/asst_123/owner-consent/",
    );
    const headers = new Headers(fetchCalls[0]?.init?.headers);
    expect(headers.get("Authorization")).toBe("Api-Key assistant-key");
    // The heartbeat awaits this check, so it must carry a deadline.
    expect(fetchCalls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  // Only the platform's own refusal may drive a rotation.
  test.each([401, 403])("a %i is the settled rejection", async (status) => {
    fetchImpl = async () => new Response("", { status });
    const client = await createClient();
    expect(await client.verifyCredential()).toBe("rejected");
  });

  test("a server error is unsettled, not a rejection", async () => {
    fetchImpl = async () => new Response("", { status: 503 });
    const client = await createClient();
    expect(await client.verifyCredential()).toBe("unknown");
  });

  test("an unreachable platform is unsettled, not a rejection", async () => {
    fetchImpl = async () => {
      throw new TypeError("fetch failed");
    };
    const client = await createClient();
    expect(await client.verifyCredential()).toBe("unknown");
  });

  test("without a platform assistant id there is nothing to verify", async () => {
    platformAssistantId = "";
    const client = await createClient();
    expect(await client.verifyCredential()).toBe("unknown");
    expect(fetchCalls).toHaveLength(0);
  });
});

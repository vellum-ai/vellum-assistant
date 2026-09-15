import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  getPlatformBaseUrl,
  setPlatformAssistantId,
  setPlatformBaseUrl,
  setPlatformOrganizationId,
  setPlatformUserId,
} from "../env.js";

const actualSecureKeys = await import("../../security/secure-keys.js");
mock.module("../../security/secure-keys.js", () => ({
  ...actualSecureKeys,
  getSecureKeyAsync: async () => undefined,
}));

const {
  _resetPlatformIdentityEnsureForTests,
  fetchPlatformIdentityIds,
  PLATFORM_IDENTITY_VALIDATE_PATH,
  resolvePlatformAssistantId,
} = await import("../platform-identity.js");

const BASE_URL = "https://platform.vellum.ai";
const ASSISTANT_ID = "11111111-2222-4333-8444-555555555555";
const ORG_ID = "22222222-3333-4444-8555-666666666666";
const USER_ID = "33333333-4444-4555-8666-777777777777";

describe("fetchPlatformIdentityIds", () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  let fetchImpl: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response> = async () =>
    new Response("not found", { status: 404 });

  beforeEach(() => {
    fetchCalls.length = 0;
    fetchImpl = async () => new Response("not found", { status: 404 });
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string" ? input : input.toString();
      fetchCalls.push({ url, init });
      return fetchImpl(input, init);
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns the three ids from a successful validate response", async () => {
    fetchImpl = async () =>
      new Response(
        JSON.stringify({
          assistant_id: ASSISTANT_ID,
          organization_id: ORG_ID,
          user_id: USER_ID,
          name: "Example Assistant",
        }),
        { status: 200 },
      );

    await expect(
      fetchPlatformIdentityIds(BASE_URL, "assistant-key"),
    ).resolves.toEqual({
      assistantId: ASSISTANT_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
    });
    expect(fetchCalls[0]?.url).toBe(
      `${BASE_URL}${PLATFORM_IDENTITY_VALIDATE_PATH}`,
    );
    expect(fetchCalls[0]?.init?.method).toBe("POST");
    const headers = new Headers(fetchCalls[0]?.init?.headers);
    expect(headers.get("Authorization")).toBe("Api-Key assistant-key");
  });

  test("strips a trailing slash from the base URL", async () => {
    fetchImpl = async () =>
      new Response(
        JSON.stringify({
          assistant_id: ASSISTANT_ID,
          organization_id: ORG_ID,
          user_id: USER_ID,
        }),
        { status: 200 },
      );

    await fetchPlatformIdentityIds(`${BASE_URL}/`, "assistant-key");
    expect(fetchCalls[0]?.url).toBe(
      `${BASE_URL}${PLATFORM_IDENTITY_VALIDATE_PATH}`,
    );
  });

  test("returns null on 401 without throwing", async () => {
    fetchImpl = async () => new Response("no", { status: 401 });
    await expect(
      fetchPlatformIdentityIds(BASE_URL, "assistant-key"),
    ).resolves.toBeNull();
  });

  test("returns null on a network error without throwing", async () => {
    fetchImpl = async () => {
      throw new Error("network down");
    };
    await expect(
      fetchPlatformIdentityIds(BASE_URL, "assistant-key"),
    ).resolves.toBeNull();
  });
});

describe("resolvePlatformAssistantId", () => {
  const originalFetch = globalThis.fetch;
  const originalAssistantApiKeyEnv = process.env.ASSISTANT_API_KEY;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  let fetchImpl: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response> = async () =>
    new Response("not found", { status: 404 });

  beforeEach(() => {
    fetchCalls.length = 0;
    fetchImpl = async () => new Response("not found", { status: 404 });
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string" ? input : input.toString();
      fetchCalls.push({ url, init });
      return fetchImpl(input, init);
    }) as unknown as typeof fetch;
    delete process.env.ASSISTANT_API_KEY;
    setPlatformBaseUrl(undefined);
    setPlatformAssistantId(undefined);
    setPlatformOrganizationId(undefined);
    setPlatformUserId(undefined);
    _resetPlatformIdentityEnsureForTests();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalAssistantApiKeyEnv === undefined) {
      delete process.env.ASSISTANT_API_KEY;
    } else {
      process.env.ASSISTANT_API_KEY = originalAssistantApiKeyEnv;
    }
    setPlatformBaseUrl(undefined);
    setPlatformAssistantId(undefined);
    setPlatformOrganizationId(undefined);
    setPlatformUserId(undefined);
    _resetPlatformIdentityEnsureForTests();
  });

  test("returns the in-memory override without calling validate", async () => {
    setPlatformAssistantId(ASSISTANT_ID);
    process.env.ASSISTANT_API_KEY = "assistant-key";
    await expect(resolvePlatformAssistantId()).resolves.toBe(ASSISTANT_ID);
    expect(fetchCalls).toHaveLength(0);
  });

  test("returns empty when the in-memory override is unset and there is no API key", async () => {
    await expect(resolvePlatformAssistantId()).resolves.toBe("");
    expect(fetchCalls).toHaveLength(0);
  });

  test("loads ids from validate when the in-memory override is empty", async () => {
    process.env.ASSISTANT_API_KEY = "assistant-key";
    setPlatformBaseUrl(BASE_URL);
    fetchImpl = async () =>
      new Response(
        JSON.stringify({
          assistant_id: ASSISTANT_ID,
          organization_id: ORG_ID,
          user_id: USER_ID,
        }),
        { status: 200 },
      );

    await expect(resolvePlatformAssistantId()).resolves.toBe(ASSISTANT_ID);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe(
      `${getPlatformBaseUrl().replace(/\/+$/, "")}${PLATFORM_IDENTITY_VALIDATE_PATH}`,
    );
  });

  test("does not retry validate during the cooldown after a failure", async () => {
    process.env.ASSISTANT_API_KEY = "assistant-key";
    setPlatformBaseUrl(BASE_URL);
    fetchImpl = async () => new Response("down", { status: 503 });

    await expect(resolvePlatformAssistantId()).resolves.toBe("");
    await expect(resolvePlatformAssistantId()).resolves.toBe("");
    expect(fetchCalls).toHaveLength(1);
  });

  test("retries validate after a failed attempt once the cooldown is cleared", async () => {
    process.env.ASSISTANT_API_KEY = "assistant-key";
    setPlatformBaseUrl(BASE_URL);
    fetchImpl = async () => new Response("down", { status: 503 });

    await expect(resolvePlatformAssistantId()).resolves.toBe("");
    _resetPlatformIdentityEnsureForTests();
    fetchImpl = async () =>
      new Response(
        JSON.stringify({
          assistant_id: ASSISTANT_ID,
          organization_id: ORG_ID,
          user_id: USER_ID,
        }),
        { status: 200 },
      );

    await expect(resolvePlatformAssistantId()).resolves.toBe(ASSISTANT_ID);
    expect(fetchCalls).toHaveLength(2);
  });

  test("concurrent resolves share one in-flight validate", async () => {
    process.env.ASSISTANT_API_KEY = "assistant-key";
    setPlatformBaseUrl(BASE_URL);
    let release!: (value: Response) => void;
    let notifyFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      notifyFetchStarted = resolve;
    });
    fetchImpl = () => {
      notifyFetchStarted();
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    };

    const first = resolvePlatformAssistantId();
    const second = resolvePlatformAssistantId();
    await fetchStarted;
    expect(fetchCalls).toHaveLength(1);
    release(
      new Response(
        JSON.stringify({
          assistant_id: ASSISTANT_ID,
          organization_id: ORG_ID,
          user_id: USER_ID,
        }),
        { status: 200 },
      ),
    );
    await expect(first).resolves.toBe(ASSISTANT_ID);
    await expect(second).resolves.toBe(ASSISTANT_ID);
    expect(fetchCalls).toHaveLength(1);
  });
});

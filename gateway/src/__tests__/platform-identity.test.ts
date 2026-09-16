import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import "./test-preload.js";

const credentialReads: string[] = [];
let credentialResults = new Map<
  string,
  { value: string | undefined; unreachable: boolean }
>();

const actualCredentialReader = await import("../credential-reader.js");
mock.module("../credential-reader.js", () => ({
  ...actualCredentialReader,
  readCredentialResult: async (account: string) => {
    credentialReads.push(account);
    return (
      credentialResults.get(account) ?? {
        value: undefined,
        unreachable: false,
      }
    );
  },
}));

const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
let fetchImplFn: (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response> = async () => new Response("not found", { status: 404 });

mock.module("../fetch.js", () => ({
  fetchImpl: (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    fetchCalls.push({ url, init });
    return fetchImplFn(input, init);
  },
}));

const {
  _resetPlatformIdentityForTests,
  applyPlatformIdentityIds,
  fetchPlatformIdentityIds,
  PLATFORM_IDENTITY_VALIDATE_PATH,
  readStoredPlatformUserId,
  resolvePlatformAssistantId,
} = await import("../platform-identity.js");
const { credentialKey } = await import("../credential-key.js");

const BASE_URL = "https://platform.example.com";
const ASSISTANT_ID = "11111111-2222-4333-8444-555555555555";
const ORG_ID = "22222222-3333-4444-8555-666666666666";
const USER_ID = "33333333-4444-4555-8666-777777777777";
const API_KEY_ACCOUNT = credentialKey("vellum", "assistant_api_key");
const BASE_URL_ACCOUNT = credentialKey("vellum", "platform_base_url");
const USER_ID_ACCOUNT = credentialKey("vellum", "platform_user_id");
const ASSISTANT_ID_ACCOUNT = credentialKey("vellum", "platform_assistant_id");
const ORG_ID_ACCOUNT = credentialKey("vellum", "platform_organization_id");

const originalAssistantApiKey = process.env.ASSISTANT_API_KEY;
const originalPlatformUrl = process.env.VELLUM_PLATFORM_URL;
const originalPlatformAssistantId = process.env.PLATFORM_ASSISTANT_ID;
const originalPlatformOrgId = process.env.PLATFORM_ORGANIZATION_ID;
const originalPlatformUserId = process.env.PLATFORM_USER_ID;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function validateResponse(ids?: {
  assistantId?: string;
  organizationId?: string;
  userId?: string;
}): Response {
  return new Response(
    JSON.stringify({
      assistant_id: ids?.assistantId ?? ASSISTANT_ID,
      organization_id: ids?.organizationId ?? ORG_ID,
      user_id: ids?.userId ?? USER_ID,
    }),
    { status: 200 },
  );
}

beforeEach(() => {
  credentialReads.length = 0;
  credentialResults = new Map();
  fetchCalls.length = 0;
  fetchImplFn = async () => new Response("not found", { status: 404 });
  delete process.env.ASSISTANT_API_KEY;
  delete process.env.VELLUM_PLATFORM_URL;
  delete process.env.PLATFORM_ASSISTANT_ID;
  delete process.env.PLATFORM_ORGANIZATION_ID;
  delete process.env.PLATFORM_USER_ID;
  _resetPlatformIdentityForTests();
});

afterEach(() => {
  restoreEnv("ASSISTANT_API_KEY", originalAssistantApiKey);
  restoreEnv("VELLUM_PLATFORM_URL", originalPlatformUrl);
  restoreEnv("PLATFORM_ASSISTANT_ID", originalPlatformAssistantId);
  restoreEnv("PLATFORM_ORGANIZATION_ID", originalPlatformOrgId);
  restoreEnv("PLATFORM_USER_ID", originalPlatformUserId);
  _resetPlatformIdentityForTests();
});

describe("fetchPlatformIdentityIds", () => {
  test("returns the three ids from a successful validate response", async () => {
    fetchImplFn = async () => validateResponse();

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
    fetchImplFn = async () => validateResponse();
    await fetchPlatformIdentityIds(`${BASE_URL}/`, "assistant-key");
    expect(fetchCalls[0]?.url).toBe(
      `${BASE_URL}${PLATFORM_IDENTITY_VALIDATE_PATH}`,
    );
  });

  test("returns null on 401 without throwing", async () => {
    fetchImplFn = async () => new Response("no", { status: 401 });
    await expect(
      fetchPlatformIdentityIds(BASE_URL, "assistant-key"),
    ).resolves.toBeNull();
  });

  test("returns null on a network error without throwing", async () => {
    fetchImplFn = async () => {
      throw new Error("network down");
    };
    await expect(
      fetchPlatformIdentityIds(BASE_URL, "assistant-key"),
    ).resolves.toBeNull();
  });
});

describe("resolvePlatformAssistantId", () => {
  test("returns the in-memory override without calling validate", async () => {
    applyPlatformIdentityIds({
      assistantId: ASSISTANT_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
    });
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
    process.env.VELLUM_PLATFORM_URL = BASE_URL;
    fetchImplFn = async () => validateResponse();

    await expect(resolvePlatformAssistantId()).resolves.toBe(ASSISTANT_ID);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe(
      `${BASE_URL}${PLATFORM_IDENTITY_VALIDATE_PATH}`,
    );
  });

  test("does not retry validate during the cooldown after a failure", async () => {
    process.env.ASSISTANT_API_KEY = "assistant-key";
    process.env.VELLUM_PLATFORM_URL = BASE_URL;
    fetchImplFn = async () => new Response("down", { status: 503 });

    await expect(resolvePlatformAssistantId()).resolves.toBe("");
    await expect(resolvePlatformAssistantId()).resolves.toBe("");
    expect(fetchCalls).toHaveLength(1);
  });

  test("retries validate after a failed attempt once the cooldown is cleared", async () => {
    process.env.ASSISTANT_API_KEY = "assistant-key";
    process.env.VELLUM_PLATFORM_URL = BASE_URL;
    fetchImplFn = async () => new Response("down", { status: 503 });

    await expect(resolvePlatformAssistantId()).resolves.toBe("");
    _resetPlatformIdentityForTests();
    fetchImplFn = async () => validateResponse();

    await expect(resolvePlatformAssistantId()).resolves.toBe(ASSISTANT_ID);
    expect(fetchCalls).toHaveLength(2);
  });

  test("concurrent resolves share one in-flight validate", async () => {
    process.env.ASSISTANT_API_KEY = "assistant-key";
    process.env.VELLUM_PLATFORM_URL = BASE_URL;
    let release!: (value: Response) => void;
    let notifyFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      notifyFetchStarted = resolve;
    });
    fetchImplFn = () => {
      notifyFetchStarted();
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    };

    const first = resolvePlatformAssistantId();
    const second = resolvePlatformAssistantId();
    await fetchStarted;
    expect(fetchCalls).toHaveLength(1);
    release(validateResponse());
    await expect(first).resolves.toBe(ASSISTANT_ID);
    await expect(second).resolves.toBe(ASSISTANT_ID);
    expect(fetchCalls).toHaveLength(1);
  });
});

describe("readStoredPlatformUserId", () => {
  test("returns a live owner id from in-memory identity", async () => {
    applyPlatformIdentityIds({
      assistantId: ASSISTANT_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
    });
    await expect(readStoredPlatformUserId()).resolves.toEqual({
      userId: USER_ID,
      unreachable: false,
    });
    expect(fetchCalls).toHaveLength(0);
  });

  test("loads the owner id from validate and keeps it when validate later fails", async () => {
    process.env.ASSISTANT_API_KEY = "assistant-key";
    process.env.VELLUM_PLATFORM_URL = BASE_URL;
    fetchImplFn = async () => validateResponse();

    await expect(readStoredPlatformUserId()).resolves.toEqual({
      userId: USER_ID,
      unreachable: false,
    });

    fetchImplFn = async () => new Response("down", { status: 503 });
    await expect(readStoredPlatformUserId()).resolves.toEqual({
      userId: USER_ID,
      unreachable: false,
    });
    expect(fetchCalls).toHaveLength(1);
  });

  test("reports unreachable when the API key vault is down and nothing is cached", async () => {
    credentialResults.set(API_KEY_ACCOUNT, {
      value: undefined,
      unreachable: true,
    });
    await expect(readStoredPlatformUserId()).resolves.toEqual({
      userId: undefined,
      unreachable: true,
    });
    expect(fetchCalls).toHaveLength(0);
  });

  test("reports a miss when the vault is up and validate has no ids", async () => {
    credentialResults.set(API_KEY_ACCOUNT, {
      value: "assistant-key",
      unreachable: false,
    });
    credentialResults.set(BASE_URL_ACCOUNT, {
      value: BASE_URL,
      unreachable: false,
    });
    fetchImplFn = async () => new Response("no", { status: 401 });

    await expect(readStoredPlatformUserId()).resolves.toEqual({
      userId: undefined,
      unreachable: false,
    });
  });

  test("reports unreachable when the API key is present but the base URL vault is down", async () => {
    process.env.ASSISTANT_API_KEY = "assistant-key";
    credentialResults.set(BASE_URL_ACCOUNT, {
      value: undefined,
      unreachable: true,
    });
    await expect(readStoredPlatformUserId()).resolves.toEqual({
      userId: undefined,
      unreachable: true,
    });
    expect(fetchCalls).toHaveLength(0);
  });

  test("reports a miss when the API key is present and the base URL is unset", async () => {
    process.env.ASSISTANT_API_KEY = "assistant-key";
    credentialResults.set(BASE_URL_ACCOUNT, {
      value: undefined,
      unreachable: false,
    });
    await expect(readStoredPlatformUserId()).resolves.toEqual({
      userId: undefined,
      unreachable: false,
    });
    expect(fetchCalls).toHaveLength(0);
  });

  test("revalidates when the assistant API key changes", async () => {
    const nextAssistantId = "44444444-5555-4666-8777-888888888888";
    const nextUserId = "55555555-6666-4777-8888-999999999999";
    process.env.ASSISTANT_API_KEY = "assistant-key";
    process.env.VELLUM_PLATFORM_URL = BASE_URL;
    fetchImplFn = async () => validateResponse();

    await expect(readStoredPlatformUserId()).resolves.toEqual({
      userId: USER_ID,
      unreachable: false,
    });

    process.env.ASSISTANT_API_KEY = "next-assistant-key";
    fetchImplFn = async () =>
      validateResponse({
        assistantId: nextAssistantId,
        organizationId: ORG_ID,
        userId: nextUserId,
      });

    await expect(readStoredPlatformUserId()).resolves.toEqual({
      userId: nextUserId,
      unreachable: false,
    });
    await expect(resolvePlatformAssistantId()).resolves.toBe(nextAssistantId);
    expect(fetchCalls).toHaveLength(2);
    const headers = new Headers(fetchCalls[1]?.init?.headers);
    expect(headers.get("Authorization")).toBe("Api-Key next-assistant-key");
  });

  test("drops bound identity when credentials change and validate fails", async () => {
    process.env.ASSISTANT_API_KEY = "assistant-key";
    process.env.VELLUM_PLATFORM_URL = BASE_URL;
    fetchImplFn = async () => validateResponse();

    await expect(readStoredPlatformUserId()).resolves.toEqual({
      userId: USER_ID,
      unreachable: false,
    });

    process.env.ASSISTANT_API_KEY = "next-assistant-key";
    fetchImplFn = async () => new Response("no", { status: 401 });

    await expect(readStoredPlatformUserId()).resolves.toEqual({
      userId: undefined,
      unreachable: false,
    });
    expect(fetchCalls).toHaveLength(2);
  });

  test("keeps bound identity when the vault is down and the new API key cannot be read", async () => {
    process.env.ASSISTANT_API_KEY = "assistant-key";
    process.env.VELLUM_PLATFORM_URL = BASE_URL;
    fetchImplFn = async () => validateResponse();

    await expect(readStoredPlatformUserId()).resolves.toEqual({
      userId: USER_ID,
      unreachable: false,
    });

    delete process.env.ASSISTANT_API_KEY;
    credentialResults.set(API_KEY_ACCOUNT, {
      value: undefined,
      unreachable: true,
    });
    fetchImplFn = async () => new Response("down", { status: 503 });

    await expect(readStoredPlatformUserId()).resolves.toEqual({
      userId: USER_ID,
      unreachable: false,
    });
    expect(fetchCalls).toHaveLength(1);
  });

  test("does not read platform identity ids from the credential store", async () => {
    process.env.ASSISTANT_API_KEY = "assistant-key";
    process.env.VELLUM_PLATFORM_URL = BASE_URL;
    fetchImplFn = async () => validateResponse();

    await readStoredPlatformUserId();

    expect(credentialReads).not.toContain(USER_ID_ACCOUNT);
    expect(credentialReads).not.toContain(ASSISTANT_ID_ACCOUNT);
    expect(credentialReads).not.toContain(ORG_ID_ACCOUNT);
  });
});

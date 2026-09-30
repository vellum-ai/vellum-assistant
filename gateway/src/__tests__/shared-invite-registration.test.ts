/**
 * Tests for registering `vellum-shared` invites with the platform during
 * invite creation (`createInviteNative`). The gateway DB is real; the
 * platform, credential store, feature flags and daemon IPC are stubbed.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import { hashInviteToken } from "@vellumai/gateway-client";

type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
let fetchMock: ReturnType<typeof mock<FetchFn>> = mock(
  async () => new Response(null, { status: 204 }),
);
mock.module("../fetch.js", () => ({
  fetchImpl: (...args: Parameters<FetchFn>) => fetchMock(...args),
}));

let ipcCalls: string[] = [];
const actualAssistantClient = await import("../ipc/assistant-client.js");
mock.module("../ipc/assistant-client.js", () => ({
  ...actualAssistantClient,
  ipcCallAssistant: async (method: string) => {
    ipcCalls.push(method);
    return {};
  },
}));

let trustedContactsEnabled = true;
const actualFlagResolver = await import("../feature-flag-resolver.js");
mock.module("../feature-flag-resolver.js", () => ({
  ...actualFlagResolver,
  isFeatureFlagEnabled: (flag: string) =>
    flag === "vellum-trusted-contacts" ? trustedContactsEnabled : false,
}));

type StoredCredential = { value: string | undefined; unreachable: boolean };
let storedCredentials: Record<string, StoredCredential> = {};
const actualCredentialReader = await import("../credential-reader.js");
mock.module("../credential-reader.js", () => ({
  ...actualCredentialReader,
  readCredentialResult: async (account: string) =>
    storedCredentials[account] ?? { value: undefined, unreachable: false },
}));

await import("./test-preload.js");

const { initGatewayDb, getGatewayDb, resetGatewayDb } =
  await import("../db/connection.js");
const { contacts, ingressInvites } = await import("../db/schema.js");
const { credentialKey } = await import("../credential-key.js");
const { createInviteNative, createContactsControlPlaneProxyHandler } =
  await import("../http/routes/contacts-control-plane-proxy.js");
const { seedContact } = await import("./helpers/contact-fixtures.js");

const BASE_URL_KEY = credentialKey("vellum", "platform_base_url");
const API_KEY_KEY = credentialKey("vellum", "assistant_api_key");
const PLATFORM_URL = "https://platform.example.com";
const API_KEY = "vak_test_key";
const CONTACT_ID = "contact-alice";

function withPlatformCredentials(): void {
  storedCredentials = {
    [BASE_URL_KEY]: { value: `${PLATFORM_URL}/`, unreachable: false },
    [API_KEY_KEY]: { value: API_KEY, unreachable: false },
  };
}

function inviteRows() {
  return getGatewayDb().select().from(ingressInvites).all();
}

function activeInviteRows() {
  return inviteRows().filter((row) => row.status === "active");
}

beforeAll(async () => {
  await initGatewayDb();
});

afterAll(() => {
  resetGatewayDb();
});

beforeEach(() => {
  const db = getGatewayDb();
  db.delete(ingressInvites).run();
  db.delete(contacts).run();
  seedContact({ id: CONTACT_ID, displayName: "Alice" });
  fetchMock = mock(async () => new Response(null, { status: 204 }));
  ipcCalls = [];
  trustedContactsEnabled = true;
  withPlatformCredentials();
  delete process.env.VELLUM_DISABLE_PLATFORM;
  delete process.env.IS_PLATFORM;
  delete process.env.VELLUM_PLATFORM_URL;
  delete process.env.ASSISTANT_API_KEY;
});

describe("vellum-shared invite registration", () => {
  test("registers the token hash and expiry with the assistant API key", async () => {
    const before = Date.now();
    const result = await createInviteNative({
      contactId: CONTACT_ID,
      sourceChannel: "vellum-shared",
      expiresInMs: 60 * 60 * 1000,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${PLATFORM_URL}/v1/internal/shared-invites/`);
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Api-Key ${API_KEY}`);
    expect(headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(init?.body as string);
    expect(Object.keys(body).sort()).toEqual(["code_hash", "expires_at"]);
    expect(body.code_hash).toBe(hashInviteToken(result.rawToken!));
    expect(body.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(Number.isInteger(body.expires_at)).toBe(true);
    expect(body.expires_at).toBe(result.invite.expiresAt);
    expect(body.expires_at).toBeGreaterThanOrEqual(before + 60 * 60 * 1000);

    const rows = activeInviteRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sourceChannel).toBe("vellum-shared");
    expect(rows[0]!.tokenHash).toBe(body.code_hash);
  });

  test("sends an integer expiry for a fractional lifetime", async () => {
    await createInviteNative({
      contactId: CONTACT_ID,
      sourceChannel: "vellum-shared",
      expiresInMs: 90_000.5,
    });

    const body = JSON.parse(fetchMock.mock.calls[0]![1]?.body as string);
    expect(Number.isInteger(body.expires_at)).toBe(true);
  });

  test("falls back to the environment for platform credentials", async () => {
    storedCredentials = {};
    process.env.VELLUM_PLATFORM_URL = PLATFORM_URL;
    process.env.ASSISTANT_API_KEY = "vak_env_key";

    await createInviteNative({
      contactId: CONTACT_ID,
      sourceChannel: "vellum-shared",
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${PLATFORM_URL}/v1/internal/shared-invites/`);
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      "Api-Key vak_env_key",
    );
  });

  test("the HTTP create returns the invite after registering", async () => {
    const handler = createContactsControlPlaneProxyHandler(
      {} as Parameters<typeof createContactsControlPlaneProxyHandler>[0],
    );
    const res = await handler.handleCreateInvite(
      new Request("http://localhost/v1/contacts/invites", {
        method: "POST",
        body: JSON.stringify({
          contactId: CONTACT_ID,
          sourceChannel: "vellum-shared",
        }),
      }),
    );

    expect(res.status).toBe(201);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(activeInviteRows()).toHaveLength(1);
  });
});

describe("registration is skipped", () => {
  test("for an invite on another channel", async () => {
    const result = await createInviteNative({
      contactId: CONTACT_ID,
      sourceChannel: "telegram",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.rawToken).toBeDefined();
    expect(activeInviteRows()).toHaveLength(1);
  });

  test("when platform features are disabled", async () => {
    process.env.VELLUM_DISABLE_PLATFORM = "true";

    await createInviteNative({
      contactId: CONTACT_ID,
      sourceChannel: "vellum-shared",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(activeInviteRows()).toHaveLength(1);
  });

  test("when no platform credentials are configured", async () => {
    storedCredentials = {};

    await createInviteNative({
      contactId: CONTACT_ID,
      sourceChannel: "vellum-shared",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(activeInviteRows()).toHaveLength(1);
  });

  test("when only the base URL is configured", async () => {
    storedCredentials = {
      [BASE_URL_KEY]: { value: PLATFORM_URL, unreachable: false },
    };

    await createInviteNative({
      contactId: CONTACT_ID,
      sourceChannel: "vellum-shared",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(activeInviteRows()).toHaveLength(1);
  });

  test("when the trusted-contacts flag is off", async () => {
    trustedContactsEnabled = false;

    await createInviteNative({
      contactId: CONTACT_ID,
      sourceChannel: "vellum-shared",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(activeInviteRows()).toHaveLength(1);
  });
});

describe("a failed registration leaves no invite", () => {
  async function expectCreateRejected(
    status: number,
    code: string,
  ): Promise<void> {
    let caught: unknown;
    try {
      await createInviteNative({
        contactId: CONTACT_ID,
        sourceChannel: "vellum-shared",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ statusCode: status, code });
    expect(inviteRows()).toHaveLength(0);
    expect(ipcCalls).not.toContain("emit_event");
  }

  test("a duplicate hash surfaces as 409", async () => {
    fetchMock = mock(async () => new Response(null, { status: 409 }));
    await expectCreateRejected(409, "INVITE_ALREADY_REGISTERED");
  });

  test("too many outstanding invites surfaces as 429", async () => {
    fetchMock = mock(async () => new Response(null, { status: 429 }));
    await expectCreateRejected(429, "TOO_MANY_OUTSTANDING_INVITES");
  });

  test("a platform error surfaces as 502", async () => {
    fetchMock = mock(async () => new Response(null, { status: 503 }));
    await expectCreateRejected(502, "INVITE_REGISTRATION_FAILED");
  });

  test("a platform refusal surfaces as 502", async () => {
    fetchMock = mock(async () => new Response(null, { status: 404 }));
    await expectCreateRejected(502, "INVITE_REGISTRATION_FAILED");
  });

  test("a transport failure surfaces as 502", async () => {
    fetchMock = mock(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    await expectCreateRejected(502, "INVITE_REGISTRATION_FAILED");
  });

  test("an unreachable credential store surfaces as 503 without calling the platform", async () => {
    storedCredentials = {
      [BASE_URL_KEY]: { value: undefined, unreachable: true },
      [API_KEY_KEY]: { value: API_KEY, unreachable: false },
    };
    await expectCreateRejected(503, "INVITE_REGISTRATION_UNAVAILABLE");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("the HTTP create answers with the registration status", async () => {
    fetchMock = mock(async () => new Response(null, { status: 429 }));
    const handler = createContactsControlPlaneProxyHandler(
      {} as Parameters<typeof createContactsControlPlaneProxyHandler>[0],
    );
    const res = await handler.handleCreateInvite(
      new Request("http://localhost/v1/contacts/invites", {
        method: "POST",
        body: JSON.stringify({
          contactId: CONTACT_ID,
          sourceChannel: "vellum-shared",
        }),
      }),
    );

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error: {
        code: "TOO_MANY_OUTSTANDING_INVITES",
        message: "Too many outstanding invites",
      },
    });
    expect(inviteRows()).toHaveLength(0);
  });
});

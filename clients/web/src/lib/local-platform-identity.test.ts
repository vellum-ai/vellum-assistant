import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const RUNTIME_ASSISTANT_ID = "qa-loopback-auth";
const PLATFORM_ASSISTANT_ID = "019ed7d1-e995-71cc-9859-c54f422ace3c";
const OTHER_PLATFORM_ASSISTANT_ID = "019ed7d1-e995-71cc-9859-c54f422ace3d";
const ORGANIZATION_ID = "019ed7d1-e995-71cc-9859-c54f422ace3e";
const GATEWAY_URL = "http://localhost:5173/assistant/__gateway/20101";
const HOST_INSTALLATION_ID = "host-installation-1";
const STATUS_PLATFORM_BASE_URL = "https://registered-platform.example.com";
const CONFIG_PLATFORM_BASE_URL = "http://localhost:8000";

type RecordedRequest = {
  pathname: string;
  body: unknown;
};

let activeAssistant = {
  assistantId: RUNTIME_ASSISTANT_ID,
  cloud: "local",
  organizationId: ORGANIZATION_ID,
  resources: { gatewayPort: 20101 },
};
let isLocalModeValue = true;
let isPlatformDisabledValue = false;
let isRemoteGatewayModeValue = false;
let selfHostedIngressUrl: string | null = GATEWAY_URL;
let selfHostedActorToken: string | null = "actor-token";
let browserDeviceId: string | null = null;
let statusBody: unknown;
let ensureRegistrationBody: unknown;
let reprovisionApiKeyBody: unknown;
let requests: RecordedRequest[] = [];
let secretsUnavailable = false;
let storedSecrets: string[] = [];

const buildVellumMutatingHeadersMock = mock(
  async (
    headers: Record<string, string>,
    options: { organizationId?: string },
  ) => ({
    ...headers,
    "X-Test-Organization-Id": options.organizationId ?? "",
  }),
);
const primeLocalGatewayConnectionWithRepairMock = mock(async () => {});
const fetchOrganizationsMock = mock(async () => {});
const updateLockfileAssistantMock = mock(async (_assistant: unknown) => {});

mock.module("@/lib/auth/request-headers", () => ({
  buildVellumMutatingHeaders: buildVellumMutatingHeadersMock,
}));

mock.module("@/lib/local-mode", () => ({
  getActiveAssistant: () => activeAssistant,
  getLocalGatewayUrl: () => "/assistant/__gateway/20101",
  getPlatformRuntimeUrl: () => CONFIG_PLATFORM_BASE_URL,
  getSelectedAssistant: () => activeAssistant,
  isLocalAssistant: (assistant: { cloud?: string }) =>
    assistant?.cloud === "local",
  isLocalMode: () => isLocalModeValue,
  isPlatformDisabled: () => isPlatformDisabledValue,
  isRemoteGatewayMode: () => isRemoteGatewayModeValue,
  primeLocalGatewayConnectionWithRepair:
    primeLocalGatewayConnectionWithRepairMock,
  updateLockfileAssistant: updateLockfileAssistantMock,
}));

mock.module("@/lib/self-hosted/connection", () => ({
  getSelfHostedActorToken: () => selfHostedActorToken,
  getSelfHostedIngressUrl: () => selfHostedIngressUrl,
}));

mock.module("@/runtime/device-id", () => ({
  getDeviceId: () => browserDeviceId,
}));

mock.module("@/runtime/is-electron", () => ({
  isElectron: () => false,
}));

mock.module("@/runtime/session-token", () => ({
  getElectronSessionToken: () => null,
}));

mock.module("@/stores/organization-store", () => ({
  getActiveOrganizationIdForRequests: () => ORGANIZATION_ID,
  useOrganizationStore: {
    getState: () => ({
      fetchOrganizations: fetchOrganizationsMock,
    }),
  },
}));

const {
  bootstrapLocalAssistantPlatformIdentity,
  resetLocalPlatformIdentityCacheForTesting,
  setBootstrapRetryDelaysForTesting,
  resolveLocalAssistantPlatformIdentity,
} = await import("@/lib/local-platform-identity");

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}

function parseRequestBody(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== "string") return null;
  return JSON.parse(init.body) as unknown;
}

function requestNames(): string[] {
  return requests
    .map((request) => request.pathname.split("/").filter(Boolean).at(-1))
    .filter((value): value is string => Boolean(value));
}

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  activeAssistant = {
    assistantId: RUNTIME_ASSISTANT_ID,
    cloud: "local",
    organizationId: ORGANIZATION_ID,
    resources: { gatewayPort: 20101 },
  };
  isLocalModeValue = true;
  isPlatformDisabledValue = false;
  isRemoteGatewayModeValue = false;
  selfHostedIngressUrl = GATEWAY_URL;
  selfHostedActorToken = "actor-token";
  browserDeviceId = null;
  statusBody = {
    assistant_id: PLATFORM_ASSISTANT_ID,
    baseUrl: STATUS_PLATFORM_BASE_URL,
    organization_id: ORGANIZATION_ID,
    has_assistant_api_key: true,
    client_installation_id: HOST_INSTALLATION_ID,
  };
  ensureRegistrationBody = {
    assistant: { id: PLATFORM_ASSISTANT_ID },
    assistant_api_key: "registered-key",
  };
  reprovisionApiKeyBody = {
    provisioning: { assistant_api_key: "reprovisioned-key" },
  };
  requests = [];
  secretsUnavailable = false;
  storedSecrets = [];
  buildVellumMutatingHeadersMock.mockClear();
  primeLocalGatewayConnectionWithRepairMock.mockClear();
  fetchOrganizationsMock.mockClear();
  updateLockfileAssistantMock.mockClear();
  resetLocalPlatformIdentityCacheForTesting();
  // Single attempt by default — retry tests opt into a schedule.
  setBootstrapRetryDelaysForTesting([]);

  globalThis.fetch = mock(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL
          ? input.toString()
          : input.url,
      );
      requests.push({
        pathname: url.pathname,
        body: parseRequestBody(init),
      });

      if (
        url.pathname.endsWith(
          `/v1/assistants/${RUNTIME_ASSISTANT_ID}/platform/status`,
        )
      ) {
        return jsonResponse(statusBody);
      }
      if (
        url.pathname === "/v1/assistants/self-hosted-local/ensure-registration/"
      ) {
        return jsonResponse(ensureRegistrationBody);
      }
      if (
        url.pathname === "/v1/assistants/self-hosted-local/reprovision-api-key/"
      ) {
        return jsonResponse(reprovisionApiKeyBody);
      }
      if (url.pathname.endsWith("/v1/secrets")) {
        if (secretsUnavailable) {
          return new Response("Failed to reach assistant runtime", {
            status: 502,
          });
        }
        const name = (parseRequestBody(init) as { name?: unknown })?.name;
        if (typeof name === "string") storedSecrets.push(name);
        return jsonResponse({ ok: true });
      }
      return new Response("not found", { status: 404 });
    },
  ) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetLocalPlatformIdentityCacheForTesting();
  setBootstrapRetryDelaysForTesting(null);
});

describe("resolveLocalAssistantPlatformIdentity", () => {
  test("returns the stored platform id without registration when the API key is present", async () => {
    const platformAssistantId =
      await resolveLocalAssistantPlatformIdentity(RUNTIME_ASSISTANT_ID);

    expect(platformAssistantId).toBe(PLATFORM_ASSISTANT_ID);
    expect(requestNames()).toEqual(["status"]);
    expect(updateLockfileAssistantMock).toHaveBeenCalledWith({
      ...activeAssistant,
      platformAssistantId: PLATFORM_ASSISTANT_ID,
      platformBaseUrl: STATUS_PLATFORM_BASE_URL,
      platformOrganizationId: ORGANIZATION_ID,
    });
  });

  test("falls back to the configured platform URL when status omits its base URL", async () => {
    statusBody = {
      assistant_id: PLATFORM_ASSISTANT_ID,
      organization_id: ORGANIZATION_ID,
      has_assistant_api_key: true,
      client_installation_id: HOST_INSTALLATION_ID,
    };

    const platformAssistantId =
      await resolveLocalAssistantPlatformIdentity(RUNTIME_ASSISTANT_ID);

    expect(platformAssistantId).toBe(PLATFORM_ASSISTANT_ID);
    expect(updateLockfileAssistantMock).toHaveBeenCalledWith({
      ...activeAssistant,
      platformAssistantId: PLATFORM_ASSISTANT_ID,
      platformBaseUrl: CONFIG_PLATFORM_BASE_URL,
      platformOrganizationId: ORGANIZATION_ID,
    });
  });

  test("repairs a stored platform id when the local assistant is missing its API key", async () => {
    statusBody = {
      assistant_id: PLATFORM_ASSISTANT_ID,
      baseUrl: STATUS_PLATFORM_BASE_URL,
      organization_id: ORGANIZATION_ID,
      has_assistant_api_key: false,
      client_installation_id: HOST_INSTALLATION_ID,
    };
    ensureRegistrationBody = {
      assistant: { id: OTHER_PLATFORM_ASSISTANT_ID },
      assistant_api_key: null,
    };

    const platformAssistantId =
      await resolveLocalAssistantPlatformIdentity(RUNTIME_ASSISTANT_ID);

    expect(platformAssistantId).toBe(PLATFORM_ASSISTANT_ID);
    expect(requestNames()).toEqual([
      "status",
      "ensure-registration",
      "reprovision-api-key",
      "secrets",
      "secrets",
      "secrets",
      "secrets",
    ]);
    expect(
      requests.find((request) =>
        request.pathname.endsWith("/ensure-registration/"),
      )?.body,
    ).toEqual({
      client_installation_id: HOST_INSTALLATION_ID,
      runtime_assistant_id: RUNTIME_ASSISTANT_ID,
      client_platform: "web",
    });
    expect(
      requests.find((request) =>
        request.pathname.endsWith("/reprovision-api-key/"),
      )?.body,
    ).toEqual({
      client_installation_id: HOST_INSTALLATION_ID,
      runtime_assistant_id: RUNTIME_ASSISTANT_ID,
      client_platform: "web",
    });

    const injectedSecrets = requests
      .filter((request) => request.pathname.endsWith("/v1/secrets"))
      .map((request) => request.body);
    expect(injectedSecrets).toContainEqual({
      type: "credential",
      name: "vellum:assistant_api_key",
      value: "reprovisioned-key",
    });
    expect(injectedSecrets).toContainEqual({
      type: "credential",
      name: "vellum:platform_assistant_id",
      value: PLATFORM_ASSISTANT_ID,
    });
    expect(injectedSecrets).toContainEqual({
      type: "credential",
      name: "vellum:platform_base_url",
      value: STATUS_PLATFORM_BASE_URL,
    });
    expect(updateLockfileAssistantMock).toHaveBeenCalledWith({
      ...activeAssistant,
      platformAssistantId: PLATFORM_ASSISTANT_ID,
      platformBaseUrl: STATUS_PLATFORM_BASE_URL,
      platformOrganizationId: ORGANIZATION_ID,
    });
  });

  test("repairs gateway access by default for blocking platform identity resolution", async () => {
    selfHostedIngressUrl = null;
    selfHostedActorToken = null;
    primeLocalGatewayConnectionWithRepairMock.mockImplementationOnce(
      async () => {
        selfHostedIngressUrl = GATEWAY_URL;
        selfHostedActorToken = "actor-token";
      },
    );

    const platformAssistantId =
      await resolveLocalAssistantPlatformIdentity(RUNTIME_ASSISTANT_ID);

    expect(platformAssistantId).toBe(PLATFORM_ASSISTANT_ID);
    expect(primeLocalGatewayConnectionWithRepairMock).toHaveBeenCalledTimes(1);
    expect(requestNames()).toEqual(["status"]);
  });

  test("skips raw platform calls when platform features are disabled", async () => {
    isPlatformDisabledValue = true;

    const platformAssistantId =
      await resolveLocalAssistantPlatformIdentity(RUNTIME_ASSISTANT_ID);

    expect(platformAssistantId).toBe(RUNTIME_ASSISTANT_ID);
    expect(requestNames()).toEqual([]);
  });
});

describe("bootstrapLocalAssistantPlatformIdentity", () => {
  test("uses the same identity resolution flow for best-effort bootstrap", async () => {
    bootstrapLocalAssistantPlatformIdentity(RUNTIME_ASSISTANT_ID);
    await flushAsyncWork();

    expect(requestNames()).toEqual(["status"]);
  });

  test("does not repair gateway access during best-effort bootstrap", async () => {
    selfHostedIngressUrl = null;
    selfHostedActorToken = null;
    const onError = mock((_error: unknown) => {});

    bootstrapLocalAssistantPlatformIdentity(RUNTIME_ASSISTANT_ID, { onError });
    await flushAsyncWork();

    expect(primeLocalGatewayConnectionWithRepairMock).not.toHaveBeenCalled();
    expect(requestNames()).toEqual([]);
    expect(onError).toHaveBeenCalled();
  });

  test("uses the selected local assistant when no id is supplied", async () => {
    bootstrapLocalAssistantPlatformIdentity();
    await flushAsyncWork();

    expect(requestNames()).toEqual(["status"]);
  });

  test("does nothing when platform features are disabled", async () => {
    isPlatformDisabledValue = true;

    bootstrapLocalAssistantPlatformIdentity(RUNTIME_ASSISTANT_ID);
    await flushAsyncWork();

    expect(primeLocalGatewayConnectionWithRepairMock).not.toHaveBeenCalled();
    expect(requestNames()).toEqual([]);
  });

  // The assistant has no stored API key (so the bootstrap must register and
  // inject credentials rather than early-returning on the status probe) and
  // the daemon is mid-restart (the gateway 502s /v1/secrets).
  function simulateDaemonRestartWithMissingApiKey(): void {
    statusBody = {
      ...(statusBody as Record<string, unknown>),
      has_assistant_api_key: false,
    };
    secretsUnavailable = true;
  }

  test("retries after the daemon-unreachable window and stores the credentials", async () => {
    simulateDaemonRestartWithMissingApiKey();
    setBootstrapRetryDelaysForTesting([20]);
    const onError = mock((_error: unknown) => {});

    bootstrapLocalAssistantPlatformIdentity(RUNTIME_ASSISTANT_ID, { onError });
    await flushAsyncWork();
    expect(
      requests.filter((r) => r.pathname.endsWith("/v1/secrets")).length,
    ).toBeGreaterThan(0);

    // Daemon comes back before the retry fires.
    secretsUnavailable = false;
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(onError).not.toHaveBeenCalled();
    expect(requestNames().filter((name) => name === "status")).toHaveLength(2);
    expect(storedSecrets).toContain("vellum:assistant_api_key");
  });

  test("invokes onError only after the retry schedule is exhausted", async () => {
    simulateDaemonRestartWithMissingApiKey();
    setBootstrapRetryDelaysForTesting([1, 1]);
    const onError = mock((_error: unknown) => {});

    bootstrapLocalAssistantPlatformIdentity(RUNTIME_ASSISTANT_ID, { onError });
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(onError).toHaveBeenCalledTimes(1);
    // Initial attempt + two retries, each re-running the full flow.
    expect(requestNames().filter((name) => name === "status")).toHaveLength(3);
  });

  test("a second trigger while a retry loop is active does not start a parallel flow", async () => {
    simulateDaemonRestartWithMissingApiKey();
    setBootstrapRetryDelaysForTesting([30]);

    bootstrapLocalAssistantPlatformIdentity(RUNTIME_ASSISTANT_ID);
    await flushAsyncWork();
    const statusProbes = requestNames().filter(
      (name) => name === "status",
    ).length;

    // Re-trigger while the loop is waiting out the backoff delay.
    bootstrapLocalAssistantPlatformIdentity(RUNTIME_ASSISTANT_ID);
    await flushAsyncWork();

    expect(requestNames().filter((name) => name === "status")).toHaveLength(
      statusProbes,
    );

    // Let the pending retry drain before afterEach restores the real fetch,
    // so the loop's last attempt doesn't hit the network.
    secretsUnavailable = false;
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
});

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const RUNTIME_ASSISTANT_ID = "qa-loopback-auth";
const PLATFORM_ASSISTANT_ID = "019ed7d1-e995-71cc-9859-c54f422ace3c";
const OTHER_PLATFORM_ASSISTANT_ID = "019ed7d1-e995-71cc-9859-c54f422ace3d";
const ORGANIZATION_ID = "019ed7d1-e995-71cc-9859-c54f422ace3e";
const GATEWAY_URL = "http://localhost:5173/assistant/__gateway/20101";

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
let isRemoteGatewayModeValue = false;
let selfHostedIngressUrl: string | null = GATEWAY_URL;
let selfHostedActorToken: string | null = "actor-token";
let statusBody: unknown;
let ensureRegistrationBody: unknown;
let reprovisionApiKeyBody: unknown;
let requests: RecordedRequest[] = [];

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

mock.module("@/lib/auth/request-headers", () => ({
  buildVellumMutatingHeaders: buildVellumMutatingHeadersMock,
}));

mock.module("@/lib/local-mode", () => ({
  getActiveAssistant: () => activeAssistant,
  getLocalGatewayUrl: () => "/assistant/__gateway/20101",
  getPlatformRuntimeUrl: () => "http://localhost:8000",
  isLocalAssistant: (assistant: { cloud?: string }) => assistant?.cloud === "local",
  isLocalMode: () => isLocalModeValue,
  isRemoteGatewayMode: () => isRemoteGatewayModeValue,
  primeLocalGatewayConnectionWithRepair:
    primeLocalGatewayConnectionWithRepairMock,
}));

mock.module("@/lib/self-hosted/connection", () => ({
  getSelfHostedActorToken: () => selfHostedActorToken,
  getSelfHostedIngressUrl: () => selfHostedIngressUrl,
}));

mock.module("@/runtime/device-id", () => ({
  getDeviceId: () => "device-1",
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
  resetLocalManagedOAuthIdentityCacheForTesting,
  resolveManagedOAuthAssistantId,
} = await import("@/lib/local-managed-oauth-identity");

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

beforeEach(() => {
  activeAssistant = {
    assistantId: RUNTIME_ASSISTANT_ID,
    cloud: "local",
    organizationId: ORGANIZATION_ID,
    resources: { gatewayPort: 20101 },
  };
  isLocalModeValue = true;
  isRemoteGatewayModeValue = false;
  selfHostedIngressUrl = GATEWAY_URL;
  selfHostedActorToken = "actor-token";
  statusBody = {
    assistant_id: PLATFORM_ASSISTANT_ID,
    organization_id: ORGANIZATION_ID,
    has_assistant_api_key: true,
  };
  ensureRegistrationBody = {
    assistant: { id: PLATFORM_ASSISTANT_ID },
    assistant_api_key: "registered-key",
  };
  reprovisionApiKeyBody = {
    provisioning: { assistant_api_key: "reprovisioned-key" },
  };
  requests = [];
  buildVellumMutatingHeadersMock.mockClear();
  primeLocalGatewayConnectionWithRepairMock.mockClear();
  fetchOrganizationsMock.mockClear();
  resetLocalManagedOAuthIdentityCacheForTesting();

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
        url.pathname ===
        "/v1/assistants/self-hosted-local/ensure-registration/"
      ) {
        return jsonResponse(ensureRegistrationBody);
      }
      if (
        url.pathname ===
        "/v1/assistants/self-hosted-local/reprovision-api-key/"
      ) {
        return jsonResponse(reprovisionApiKeyBody);
      }
      if (url.pathname.endsWith("/v1/secrets")) {
        return jsonResponse({ ok: true });
      }
      return new Response("not found", { status: 404 });
    },
  ) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetLocalManagedOAuthIdentityCacheForTesting();
});

describe("resolveManagedOAuthAssistantId", () => {
  test("returns the stored platform id without registration when the API key is present", async () => {
    const assistantId = await resolveManagedOAuthAssistantId(RUNTIME_ASSISTANT_ID);

    expect(assistantId).toBe(PLATFORM_ASSISTANT_ID);
    expect(requestNames()).toEqual(["status"]);
  });

  test("repairs a stored platform id when the local assistant is missing its API key", async () => {
    statusBody = {
      assistant_id: PLATFORM_ASSISTANT_ID,
      organization_id: ORGANIZATION_ID,
      has_assistant_api_key: false,
    };
    ensureRegistrationBody = {
      assistant: { id: OTHER_PLATFORM_ASSISTANT_ID },
      assistant_api_key: null,
    };

    const assistantId = await resolveManagedOAuthAssistantId(RUNTIME_ASSISTANT_ID);

    expect(assistantId).toBe(PLATFORM_ASSISTANT_ID);
    expect(requestNames()).toEqual([
      "status",
      "ensure-registration",
      "reprovision-api-key",
      "secrets",
      "secrets",
      "secrets",
      "secrets",
    ]);

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
  });
});

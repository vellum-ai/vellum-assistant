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
let isLocalClientValue = true;
let isPlatformDisabledValue = false;
let isRemoteGatewayModeValue = false;
let selfHostedIngressUrl: string | null = GATEWAY_URL;
let selfHostedActorToken: string | null = "actor-token";
let browserDeviceId: string | null = null;
let statusBody: unknown;
let ensureRegistrationBody: unknown;
let reprovisionApiKeyBody: unknown;
/** What `POST /v1/platform/verify-credential` reports about the stored key. */
let verifyCredentialStatus: "valid" | "rejected" | "unknown" = "valid";
let requests: RecordedRequest[] = [];
let secretsUnavailable = false;
let storedSecrets: string[] = [];
let isElectronValue = false;
let electronHostOS: "macos" | "windows" | undefined;
let electronSessionToken: string | null = null;
let navigatorPlatform = "MacIntel";

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
  isLocalClient: () => isLocalClientValue,
  isLocalGatewayAssistant: (assistant: { cloud?: string }) =>
    assistant?.cloud === "local" || assistant?.cloud === "docker",
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
  isElectron: () => isElectronValue,
}));

mock.module("@/runtime/native-auth", () => ({
  isNativePlatform: () => false,
}));

Object.defineProperty(window, "vellum", {
  configurable: true,
  get: () =>
    electronHostOS
      ? { platform: "electron", hostOS: electronHostOS }
      : undefined,
});

Object.defineProperty(window.navigator, "platform", {
  configurable: true,
  get: () => navigatorPlatform,
});

mock.module("@/runtime/session-token", () => ({
  getElectronSessionToken: () => electronSessionToken,
}));

mock.module("@/stores/organization-store", () => ({
  getActiveOrganizationIdForRequests: () => ORGANIZATION_ID,
  useOrganizationStore: {
    getState: () => ({
      fetchOrganizations: fetchOrganizationsMock,
    }),
  },
}));

const { MIN_VERSION: VERIFY_ROUTE_MIN_VERSION } =
  await import("@/lib/backwards-compat/credential-verification");
const { VERSION_RESOLUTION_TIMEOUT_MS } =
  await import("@/lib/backwards-compat/utils");
const { useAssistantIdentityStore } =
  await import("@/stores/assistant-identity-store");
const {
  bootstrapLocalAssistantPlatformIdentity,
  canRecoverLocalAssistantPlatformCredential,
  LocalPlatformCredentialRecoveryError,
  resetLocalPlatformIdentityCacheForTesting,
  setBootstrapRetryDelaysForTesting,
  recoverLocalAssistantPlatformCredential,
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
  if (typeof init?.body !== "string") {
    return null;
  }
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
  isLocalClientValue = true;
  isPlatformDisabledValue = false;
  isRemoteGatewayModeValue = false;
  selfHostedIngressUrl = GATEWAY_URL;
  selfHostedActorToken = "actor-token";
  browserDeviceId = null;
  statusBody = {
    assistantId: PLATFORM_ASSISTANT_ID,
    baseUrl: STATUS_PLATFORM_BASE_URL,
    organizationId: ORGANIZATION_ID,
    hasAssistantApiKey: true,
    clientInstallationId: HOST_INSTALLATION_ID,
  };
  ensureRegistrationBody = {
    assistant: { id: PLATFORM_ASSISTANT_ID },
    assistant_api_key: "registered-key",
  };
  reprovisionApiKeyBody = {
    provisioning: { assistant_api_key: "reprovisioned-key" },
  };
  verifyCredentialStatus = "valid";
  requests = [];
  secretsUnavailable = false;
  storedSecrets = [];
  isElectronValue = false;
  electronHostOS = undefined;
  electronSessionToken = null;
  navigatorPlatform = "MacIntel";
  buildVellumMutatingHeadersMock.mockClear();
  primeLocalGatewayConnectionWithRepairMock.mockClear();
  fetchOrganizationsMock.mockClear();
  updateLockfileAssistantMock.mockClear();
  resetLocalPlatformIdentityCacheForTesting();
  useAssistantIdentityStore
    .getState()
    .setIdentity("test-asst", VERIFY_ROUTE_MIN_VERSION, RUNTIME_ASSISTANT_ID);
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
      if (url.pathname.endsWith("/v1/platform/verify-credential")) {
        return jsonResponse({ status: verifyCredentialStatus });
      }
      if (url.pathname.endsWith("/v1/secrets")) {
        if (secretsUnavailable) {
          return new Response("Failed to reach assistant runtime", {
            status: 502,
          });
        }
        const name = (parseRequestBody(init) as { name?: unknown })?.name;
        if (typeof name === "string") {
          storedSecrets.push(name);
        }
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
      assistantId: PLATFORM_ASSISTANT_ID,
      organizationId: ORGANIZATION_ID,
      hasAssistantApiKey: true,
      clientInstallationId: HOST_INSTALLATION_ID,
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

  /** The incident shape: a key IS stored, so every presence check reads
   * healthy, but the platform rejects it on every managed call. An existing
   * registration hands back no key, so only an explicit rotation can produce
   * a replacement. */
  function seedRejectedCredential() {
    statusBody = {
      assistantId: PLATFORM_ASSISTANT_ID,
      baseUrl: STATUS_PLATFORM_BASE_URL,
      organizationId: ORGANIZATION_ID,
      hasAssistantApiKey: true,
      clientInstallationId: HOST_INSTALLATION_ID,
    };
    ensureRegistrationBody = {
      assistant: { id: PLATFORM_ASSISTANT_ID },
      assistant_api_key: null,
    };
  }

  test("the user's repair rotates a stored key the platform has rejected", async () => {
    seedRejectedCredential();

    await recoverLocalAssistantPlatformCredential(RUNTIME_ASSISTANT_ID);

    expect(requestNames()).toContain("reprovision-api-key");
    const injectedSecrets = requests
      .filter((request) => request.pathname.endsWith("/v1/secrets"))
      .map((request) => request.body);
    expect(injectedSecrets).toContainEqual({
      type: "credential",
      name: "vellum:assistant_api_key",
      value: "reprovisioned-key",
    });
  });

  // Storing a credential proves the write landed, not that it works. A
  // replacement rejected in turn has to surface as a failure, or the
  // notification reports a repair that repaired nothing.
  test("a replacement the platform rejects fails the repair", async () => {
    seedRejectedCredential();
    verifyCredentialStatus = "rejected";

    await expect(
      recoverLocalAssistantPlatformCredential(RUNTIME_ASSISTANT_ID),
    ).rejects.toMatchObject({ reason: "replacement_rejected" });
  });

  // A daemon that predates the verification route cannot confirm anything.
  // Its 404 would read as a failed repair after a successful rotation and
  // invite another, so on those daemons the stored replacement is the repair.
  test("an older assistant skips verification and reports the stored replacement as the repair", async () => {
    seedRejectedCredential();
    useAssistantIdentityStore
      .getState()
      .setIdentity("test-asst", "0.11.8", RUNTIME_ASSISTANT_ID);
    verifyCredentialStatus = "rejected";

    await recoverLocalAssistantPlatformCredential(RUNTIME_ASSISTANT_ID);

    expect(requestNames()).toContain("reprovision-api-key");
    expect(requestNames()).not.toContain("verify-credential");
  });

  test("an unconfirmed replacement fails rather than claiming success", async () => {
    seedRejectedCredential();
    verifyCredentialStatus = "unknown";

    await expect(
      recoverLocalAssistantPlatformCredential(RUNTIME_ASSISTANT_ID),
    ).rejects.toMatchObject({ reason: "unconfirmed" });
  });

  // Resolving returns the id untouched for anything it does not provision for,
  // so a repair that cannot act has to say so rather than resolving as though
  // it fixed something.
  test("a repair this client cannot perform reports why", async () => {
    isLocalClientValue = false;

    const failure = await recoverLocalAssistantPlatformCredential(
      RUNTIME_ASSISTANT_ID,
    ).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(LocalPlatformCredentialRecoveryError);
    expect(failure).toMatchObject({ reason: "cannot_act_here" });
    expect(requestNames()).not.toContain("reprovision-api-key");
  });

  // The surface that offers the repair reads the same predicate the repair
  // refuses on, so a button is never rendered for a repair that would fail.
  test("the capability predicate agrees with the repair", () => {
    expect(
      canRecoverLocalAssistantPlatformCredential(RUNTIME_ASSISTANT_ID),
    ).toBe(true);
    isRemoteGatewayModeValue = true;
    expect(
      canRecoverLocalAssistantPlatformCredential(RUNTIME_ASSISTANT_ID),
    ).toBe(false);
    isRemoteGatewayModeValue = false;
    isPlatformDisabledValue = true;
    expect(
      canRecoverLocalAssistantPlatformCredential(RUNTIME_ASSISTANT_ID),
    ).toBe(false);
  });

  // A local Docker instance is never hatched, woken or retired from here, but
  // its gateway takes the same credential write a plain local assistant's
  // does, so the repair serves it rather than handing the user a CLI command
  // with a key placeholder they have no way to fill.
  test("a local Docker assistant is repairable here", async () => {
    activeAssistant = { ...activeAssistant, cloud: "docker" };
    seedRejectedCredential();

    expect(
      canRecoverLocalAssistantPlatformCredential(RUNTIME_ASSISTANT_ID),
    ).toBe(true);
    await recoverLocalAssistantPlatformCredential(RUNTIME_ASSISTANT_ID);

    expect(requestNames()).toContain("reprovision-api-key");
    const injectedSecrets = requests
      .filter((request) => request.pathname.endsWith("/v1/secrets"))
      .map((request) => request.body);
    expect(injectedSecrets).toContainEqual({
      type: "credential",
      name: "vellum:assistant_api_key",
      value: "reprovisioned-key",
    });
  });

  // The repair's wider scope must not leak into bootstrap: the web lifecycle
  // does not own a Docker instance, so it never provisions one unasked.
  test("bootstrap leaves a local Docker assistant alone", async () => {
    activeAssistant = { ...activeAssistant, cloud: "docker" };

    await resolveLocalAssistantPlatformIdentity(RUNTIME_ASSISTANT_ID);
    bootstrapLocalAssistantPlatformIdentity();
    await flushAsyncWork();

    expect(requestNames()).toEqual([]);
  });

  // The switch window: a version still held for the assistant the user just
  // left must not vouch for the one being repaired. The gate reads as
  // unsupported, so verification is skipped rather than 404ing after a
  // successful rotation.
  //
  // The scoped wait is bounded, not satisfiable: the store never holds a
  // version for this owner, so the repair waits out
  // VERSION_RESOLUTION_TIMEOUT_MS by design before it decides. That equals the
  // runner's default per-test budget, so the test carries its own budget
  // derived from the constant rather than racing it.
  test(
    "a version held for a different assistant does not enable verification",
    async () => {
      seedRejectedCredential();
      useAssistantIdentityStore
        .getState()
        .setIdentity(
          "test-asst",
          VERIFY_ROUTE_MIN_VERSION,
          "some-other-assistant",
        );
      verifyCredentialStatus = "rejected";

      await recoverLocalAssistantPlatformCredential(RUNTIME_ASSISTANT_ID);

      expect(requestNames()).toContain("reprovision-api-key");
      expect(requestNames()).not.toContain("verify-credential");
    },
    VERSION_RESOLUTION_TIMEOUT_MS + 5_000,
  );

  // Rotation replaces a credential, so it happens because someone asked and at
  // no other time. Routine identity resolution sees the same stored key and
  // leaves it alone, whatever state it is in.
  test("resolution alone never rotates a stored key", async () => {
    statusBody = {
      assistantId: PLATFORM_ASSISTANT_ID,
      baseUrl: STATUS_PLATFORM_BASE_URL,
      organizationId: ORGANIZATION_ID,
      hasAssistantApiKey: true,
      clientInstallationId: HOST_INSTALLATION_ID,
    };

    await resolveLocalAssistantPlatformIdentity(RUNTIME_ASSISTANT_ID);

    expect(requestNames()).not.toContain("reprovision-api-key");
  });

  test("repairs a stored platform id when the local assistant is missing its API key", async () => {
    statusBody = {
      assistantId: PLATFORM_ASSISTANT_ID,
      baseUrl: STATUS_PLATFORM_BASE_URL,
      organizationId: ORGANIZATION_ID,
      hasAssistantApiKey: false,
      clientInstallationId: HOST_INSTALLATION_ID,
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

  test("reports the Windows Electron host during platform registration", async () => {
    isElectronValue = true;
    electronHostOS = "windows";
    electronSessionToken = "electron-session-token";
    statusBody = {
      assistantId: PLATFORM_ASSISTANT_ID,
      baseUrl: STATUS_PLATFORM_BASE_URL,
      organizationId: ORGANIZATION_ID,
      hasAssistantApiKey: false,
      clientInstallationId: HOST_INSTALLATION_ID,
    };

    await resolveLocalAssistantPlatformIdentity(RUNTIME_ASSISTANT_ID);

    expect(
      requests.find((request) =>
        request.pathname.endsWith("/ensure-registration/"),
      )?.body,
    ).toEqual({
      client_installation_id: HOST_INSTALLATION_ID,
      runtime_assistant_id: RUNTIME_ASSISTANT_ID,
      client_platform: "windows",
    });
  });

  test("detects Windows for an Electron bridge without hostOS", async () => {
    isElectronValue = true;
    navigatorPlatform = "Win32";
    electronSessionToken = "electron-session-token";
    statusBody = {
      assistantId: PLATFORM_ASSISTANT_ID,
      baseUrl: STATUS_PLATFORM_BASE_URL,
      organizationId: ORGANIZATION_ID,
      hasAssistantApiKey: false,
      clientInstallationId: HOST_INSTALLATION_ID,
    };

    await resolveLocalAssistantPlatformIdentity(RUNTIME_ASSISTANT_ID);

    expect(
      requests.find((request) =>
        request.pathname.endsWith("/ensure-registration/"),
      )?.body,
    ).toEqual({
      client_installation_id: HOST_INSTALLATION_ID,
      runtime_assistant_id: RUNTIME_ASSISTANT_ID,
      client_platform: "windows",
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
      hasAssistantApiKey: false,
    };
    secretsUnavailable = true;
  }

  test("stores the API key sentinel only after the other credentials have landed", async () => {
    simulateDaemonRestartWithMissingApiKey();
    secretsUnavailable = false;

    bootstrapLocalAssistantPlatformIdentity(RUNTIME_ASSISTANT_ID);
    await flushAsyncWork();

    // The status probe reports has_assistant_api_key based on the API key
    // alone, and the bootstrap early-returns on it — so a partial write
    // must never leave the key stored without the rest.
    expect(storedSecrets.at(-1)).toBe("vellum:assistant_api_key");
    expect(storedSecrets).toContain("vellum:platform_base_url");
    expect(storedSecrets).toContain("vellum:platform_organization_id");
  });

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

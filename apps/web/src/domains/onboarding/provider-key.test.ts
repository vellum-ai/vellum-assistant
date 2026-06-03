import { beforeEach, describe, expect, mock, test } from "bun:test";

type ClientCall = {
  method: "patch" | "post";
  url: string;
  path?: Record<string, unknown>;
  body?: Record<string, unknown>;
};

type QueuedResponse = {
  ok: boolean;
  status: number;
  /** Daemon error envelope surfaced by the generated client on `result.error`. */
  error?: unknown;
  /** Parsed JSON body surfaced by the generated client on `result.data`. */
  data?: unknown;
};

const calls: ClientCall[] = [];
// Per-URL queue of responses; each create call shifts the next. Missing/empty
// queue defaults to 200 OK.
const responseQueues: Record<string, QueuedResponse[]> = {};

// The daemon's flag-disabled rejection message
// (assistant inference-provider-connection-routes.ts) wrapped in the standard
// error envelope (`{ error: { code, message } }`).
const FLAG_DISABLED_BODY = {
  error: {
    code: "BAD_REQUEST",
    message:
      "OpenAI-compatible endpoints are disabled. Enable the openai-compatible-endpoints feature flag to configure this provider.",
  },
};

function nextResponse(url: string): QueuedResponse {
  const queued = responseQueues[url]?.shift();
  return queued ?? { ok: true, status: 200 };
}

// Canonical daemon-SDK URLs. The generated SDK functions are invoked with
// `path`/`body` (no `url`), so the SDK mocks attribute their calls to these
// stable URL constants to keep assertions URL-keyed across both clients.
const CONNECTIONS_URL =
  "/v1/assistants/{assistant_id}/inference/provider-connections";
const SECRETS_URL = "/v1/assistants/{assistant_id}/secrets";

// Raw client (gateway routes with no typed SDK function): the feature-flag
// PATCH and the connection test POST.
const patchMock = mock(
  async (args: { url: string; body?: Record<string, unknown> }) => {
    calls.push({ method: "patch", url: args.url, body: args.body });
    const { ok, status, error } = nextResponse(args.url);
    return { response: { ok, status }, error };
  },
);

const postMock = mock(
  async (args: {
    url: string;
    path?: Record<string, unknown>;
    body?: Record<string, unknown>;
  }) => {
    calls.push({
      method: "post",
      url: args.url,
      path: args.path,
      body: args.body,
    });
    const { ok, status, error, data } = nextResponse(args.url);
    return { response: { ok, status }, error, data };
  },
);

mock.module("@/generated/api/client.gen", () => ({
  client: { patch: patchMock, post: postMock },
}));

// Generated daemon SDK: `secretsPost` (writeApiKeySecret) and
// `inferenceProviderconnectionsPost` (createProviderConnection). Both return
// heyapi-style results (`{ response, data, error }`).
const secretsPostMock = mock(
  async (args: {
    path?: Record<string, unknown>;
    body?: Record<string, unknown>;
  }) => {
    calls.push({ method: "post", url: SECRETS_URL, path: args.path, body: args.body });
    const { ok, status, error, data } = nextResponse(SECRETS_URL);
    return { response: { ok, status }, error, data };
  },
);

const inferenceProviderconnectionsPostMock = mock(
  async (args: {
    path?: Record<string, unknown>;
    body?: Record<string, unknown>;
  }) => {
    calls.push({
      method: "post",
      url: CONNECTIONS_URL,
      path: args.path,
      body: args.body,
    });
    const { ok, status, error, data } = nextResponse(CONNECTIONS_URL);
    return { response: { ok, status }, error, data };
  },
);

mock.module("@/generated/daemon/sdk.gen", () => ({
  secretsPost: secretsPostMock,
  inferenceProviderconnectionsPost: inferenceProviderconnectionsPostMock,
}));

const {
  applyPendingProviderKey,
  consumePendingProviderKey,
  peekPendingProviderKey,
  setPendingProviderKey,
} = await import("@/domains/onboarding/provider-key");

const FLAG_URL =
  "/v1/assistants/asst-1/feature-flags/openai-compatible-endpoints";
// Probe route: connection name === provider id (openai-compatible).
const TEST_URL =
  "/v1/assistants/asst-1/inference/provider-connections/openai-compatible/test";

beforeEach(() => {
  sessionStorage.clear();
  calls.length = 0;
  for (const key of Object.keys(responseQueues)) delete responseQueues[key];
  patchMock.mockClear();
  postMock.mockClear();
  secretsPostMock.mockClear();
  inferenceProviderconnectionsPostMock.mockClear();
});

describe("pending provider key", () => {
  test("round-trips provider + key through sessionStorage", () => {
    setPendingProviderKey({ provider: "anthropic", key: "sk-ant-test" });
    expect(peekPendingProviderKey()).toEqual({
      provider: "anthropic",
      key: "sk-ant-test",
    });
  });

  test("peek is non-destructive, consume clears it (consume-once)", () => {
    setPendingProviderKey({ provider: "openai", key: "sk-proj-test" });

    expect(peekPendingProviderKey()?.provider).toBe("openai");
    // Still present after peek.
    expect(peekPendingProviderKey()?.provider).toBe("openai");

    expect(consumePendingProviderKey()?.provider).toBe("openai");
    // Gone after consume.
    expect(peekPendingProviderKey()).toBeNull();
    expect(consumePendingProviderKey()).toBeNull();
  });

  test("setting null clears any pending key", () => {
    setPendingProviderKey({ provider: "gemini", key: "AIza-test" });
    setPendingProviderKey(null);
    expect(peekPendingProviderKey()).toBeNull();
  });

  test("keyless providers store an empty key", () => {
    setPendingProviderKey({ provider: "ollama", key: "" });
    expect(consumePendingProviderKey()).toEqual({ provider: "ollama", key: "" });
  });

  test("round-trips openai-compatible baseUrl + models", () => {
    setPendingProviderKey({
      provider: "openai-compatible",
      key: "",
      baseUrl: "http://localhost:1234/v1",
      models: ["model-a", "model-b"],
    });
    expect(peekPendingProviderKey()).toEqual({
      provider: "openai-compatible",
      key: "",
      baseUrl: "http://localhost:1234/v1",
      models: ["model-a", "model-b"],
    });
  });

  test("providers without custom fields round-trip without baseUrl/models", () => {
    setPendingProviderKey({ provider: "anthropic", key: "sk-ant-test" });
    const peeked = peekPendingProviderKey();
    expect(peeked).toEqual({ provider: "anthropic", key: "sk-ant-test" });
    expect(peeked?.baseUrl).toBeUndefined();
    expect(peeked?.models).toBeUndefined();
  });
});

describe("applyPendingProviderKey", () => {
  test("openai-compatible enables the flag before creating the connection", async () => {
    responseQueues[TEST_URL] = [{ ok: true, status: 200, data: { ok: true } }];

    setPendingProviderKey({
      provider: "openai-compatible",
      key: "",
      baseUrl: "http://localhost:1234/v1",
      models: ["model-a"],
    });

    const result = await applyPendingProviderKey("asst-1");

    // Flag PATCH must precede the connection POST.
    const flagIdx = calls.findIndex(
      (c) => c.method === "patch" && c.url === FLAG_URL,
    );
    const connectionIdx = calls.findIndex(
      (c) => c.method === "post" && c.url === CONNECTIONS_URL,
    );
    expect(flagIdx).toBeGreaterThanOrEqual(0);
    expect(connectionIdx).toBeGreaterThanOrEqual(0);
    expect(flagIdx).toBeLessThan(connectionIdx);

    expect(calls[flagIdx].body).toEqual({ enabled: true });

    const connectionBody = calls[connectionIdx].body as Record<string, unknown>;
    expect(connectionBody.provider).toBe("openai-compatible");
    expect(connectionBody.base_url).toBe("http://localhost:1234/v1");
    expect(connectionBody.models).toEqual([{ id: "model-a" }]);

    // The probe runs after the connection POST and its result is surfaced.
    const testIdx = calls.findIndex(
      (c) => c.method === "post" && c.url === TEST_URL,
    );
    expect(testIdx).toBeGreaterThan(connectionIdx);
    expect(result.validation).toEqual({ ok: true, reason: undefined });
  });

  test("openai-compatible surfaces a failing probe as validation", async () => {
    responseQueues[TEST_URL] = [
      { ok: true, status: 200, data: { ok: false, reason: "bad endpoint" } },
    ];

    setPendingProviderKey({
      provider: "openai-compatible",
      key: "",
      baseUrl: "http://localhost:1234/v1",
      models: ["model-a"],
    });

    const result = await applyPendingProviderKey("asst-1");

    expect(result.validation).toEqual({ ok: false, reason: "bad endpoint" });
  });

  test("non-openai-compatible provider issues no flag PATCH, a single POST, no probe, and no validation", async () => {
    setPendingProviderKey({ provider: "anthropic", key: "sk-ant-test" });

    const result = await applyPendingProviderKey("asst-1");

    expect(patchMock).not.toHaveBeenCalled();

    // A keyed provider writes its secret via the daemon SDK before creating.
    expect(secretsPostMock).toHaveBeenCalledTimes(1);

    const connectionCalls = calls.filter(
      (c) => c.method === "post" && c.url === CONNECTIONS_URL,
    );
    expect(connectionCalls.length).toBe(1);
    const body = connectionCalls[0].body as Record<string, unknown>;
    expect(body.provider).toBe("anthropic");
    expect(body.base_url).toBeUndefined();
    expect(body.models).toBeUndefined();

    // No probe for keyed non-openai-compatible providers.
    expect(calls.some((c) => c.url === TEST_URL)).toBe(false);
    expect(result.validation).toBeUndefined();
  });

  test("openai-compatible retries the connection POST on the flag-disabled 400 then succeeds", async () => {
    // First create attempt fails with the flag-disabled 400 (flag cache not
    // yet propagated), second succeeds.
    responseQueues[CONNECTIONS_URL] = [
      { ok: false, status: 400, error: FLAG_DISABLED_BODY },
      { ok: true, status: 200 },
    ];

    setPendingProviderKey({
      provider: "openai-compatible",
      key: "",
      baseUrl: "http://localhost:1234/v1",
      models: ["model-a"],
    });

    await applyPendingProviderKey("asst-1");

    const connectionCalls = calls.filter(
      (c) => c.method === "post" && c.url === CONNECTIONS_URL,
    );
    expect(connectionCalls.length).toBe(2);
  });

  test("openai-compatible does NOT retry a genuine validation 400 — throws on first attempt", async () => {
    // A real validation rejection (e.g. base_url_required) must surface
    // immediately rather than being retried as a flag-propagation delay.
    responseQueues[CONNECTIONS_URL] = [
      {
        ok: false,
        status: 400,
        error: {
          error: { code: "BAD_REQUEST", message: "base_url is required." },
        },
      },
      // Sentinel: a second attempt (if it wrongly retried) would succeed —
      // so a passing assertion of a single attempt proves no retry happened.
      { ok: true, status: 200 },
    ];

    setPendingProviderKey({
      provider: "openai-compatible",
      key: "",
      baseUrl: "http://localhost:1234/v1",
      models: ["model-a"],
    });

    await expect(applyPendingProviderKey("asst-1")).rejects.toMatchObject({
      message: "Failed to create provider connection",
      status: 400,
    });

    const connectionCalls = calls.filter(
      (c) => c.method === "post" && c.url === CONNECTIONS_URL,
    );
    expect(connectionCalls.length).toBe(1);
  });
});

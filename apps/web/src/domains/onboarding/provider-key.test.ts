import { beforeEach, describe, expect, mock, test } from "bun:test";

type ClientCall = {
  method: "patch" | "post";
  url: string;
  path?: Record<string, unknown>;
  body?: Record<string, unknown>;
};

const calls: ClientCall[] = [];
// Per-URL queue of responses; each create call shifts the next. Missing/empty
// queue defaults to 200 OK.
const responseQueues: Record<string, { ok: boolean; status: number }[]> = {};

function nextResponse(url: string): { ok: boolean; status: number } {
  const queued = responseQueues[url]?.shift();
  return queued ?? { ok: true, status: 200 };
}

const patchMock = mock(
  async (args: { url: string; body?: Record<string, unknown> }) => {
    calls.push({ method: "patch", url: args.url, body: args.body });
    return { response: nextResponse(args.url) };
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
    return { response: nextResponse(args.url) };
  },
);

mock.module("@/generated/api/client.gen", () => ({
  client: { patch: patchMock, post: postMock },
}));

const {
  applyPendingProviderKey,
  consumePendingProviderKey,
  peekPendingProviderKey,
  setPendingProviderKey,
} = await import("@/domains/onboarding/provider-key");

const CONNECTIONS_URL =
  "/v1/assistants/{assistant_id}/inference/provider-connections";
const FLAG_URL =
  "/v1/assistants/asst-1/feature-flags/openai-compatible-endpoints";

beforeEach(() => {
  sessionStorage.clear();
  calls.length = 0;
  for (const key of Object.keys(responseQueues)) delete responseQueues[key];
  patchMock.mockClear();
  postMock.mockClear();
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
    setPendingProviderKey({
      provider: "openai-compatible",
      key: "",
      baseUrl: "http://localhost:1234/v1",
      models: ["model-a"],
    });

    await applyPendingProviderKey("asst-1");

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
  });

  test("non-openai-compatible provider issues no flag PATCH and a single POST", async () => {
    setPendingProviderKey({ provider: "anthropic", key: "sk-ant-test" });

    await applyPendingProviderKey("asst-1");

    expect(patchMock).not.toHaveBeenCalled();

    const connectionCalls = calls.filter(
      (c) => c.method === "post" && c.url === CONNECTIONS_URL,
    );
    expect(connectionCalls.length).toBe(1);
    const body = connectionCalls[0].body as Record<string, unknown>;
    expect(body.provider).toBe("anthropic");
    expect(body.base_url).toBeUndefined();
    expect(body.models).toBeUndefined();
  });

  test("openai-compatible retries the connection POST on a 400 then succeeds", async () => {
    // First create attempt fails with 400 (flag cache not yet propagated),
    // second succeeds.
    responseQueues[CONNECTIONS_URL] = [
      { ok: false, status: 400 },
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
});

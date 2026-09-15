import { describe, expect, test } from "bun:test";

import {
  OPENCODE_GO_BASE_URL,
  OPENCODE_REQUEST_HEADER,
  OPENCODE_SESSION_HEADER,
} from "../../opencode/client.js";
import { testInferenceConnection } from "../endpoint-probe.js";

// Keyless auth so the probe never touches the vault; the fetch stub records
// the request instead of dialing out.
const CONNECTION = {
  provider: "openai-compatible",
  auth: { type: "none" } as const,
  baseUrl: "https://integrate.api.nvidia.com",
  models: [{ id: "meta/llama-3.1-8b-instruct" }],
};

type ProbeCall = {
  url: string;
  body: unknown;
  headers: Record<string, string>;
};

function stubFetch(status: number, calls: ProbeCall[]) {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body)),
      headers: { ...(init?.headers as Record<string, string>) },
    });
    return new Response(status < 400 ? "{}" : "404 page not found", { status });
  }) as typeof fetch;
}

describe("testInferenceConnection", () => {
  test("reports ok:false with a base-path hint on 404", async () => {
    const calls: ProbeCall[] = [];
    const result = await testInferenceConnection(
      CONNECTION,
      stubFetch(404, calls),
    );

    expect(result).toMatchObject({
      ok: false,
      status: 404,
      resolved_url: "https://integrate.api.nvidia.com/chat/completions",
      error_class: "http_error",
    });
    expect(result?.hint).toContain("/v1");
    expect(calls[0].body).toMatchObject({
      model: "meta/llama-3.1-8b-instruct",
      max_tokens: 1,
    });
  });

  test("reports ok:true on 200 from a correct base URL", async () => {
    const calls: ProbeCall[] = [];
    const result = await testInferenceConnection(
      { ...CONNECTION, baseUrl: "https://integrate.api.nvidia.com/v1" },
      stubFetch(200, calls),
    );

    expect(result).toMatchObject({
      ok: true,
      status: 200,
      resolved_url: "https://integrate.api.nvidia.com/v1/chat/completions",
    });
    expect(result?.hint).toBeUndefined();
  });

  test("hints at the credential on 401", async () => {
    const result = await testInferenceConnection(
      CONNECTION,
      stubFetch(401, []),
    );
    expect(result).toMatchObject({ ok: false, status: 401 });
    expect(result?.hint).toContain("API key");
  });

  test("reports a network error_class when the endpoint is unreachable", async () => {
    const failingFetch = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    const result = await testInferenceConnection(CONNECTION, failingFetch);
    expect(result).toMatchObject({ ok: false, error_class: "network" });
    expect(result?.hint).toContain("connection refused");
  });

  test("sends OpenCode session and request headers to an OpenCode endpoint", async () => {
    const calls: ProbeCall[] = [];
    const result = await testInferenceConnection(
      {
        ...CONNECTION,
        provider: "opencode",
        baseUrl: OPENCODE_GO_BASE_URL,
        models: [{ id: "kimi-k3" }],
      },
      stubFetch(200, calls),
    );

    expect(result).toMatchObject({ ok: true, status: 200 });
    const headers = calls[0].headers;
    expect(headers[OPENCODE_SESSION_HEADER]).toMatch(/\S/);
    expect(headers[OPENCODE_REQUEST_HEADER]).toMatch(/\S/);
    expect(headers).not.toHaveProperty("session_id");
    expect(calls[0].body).not.toHaveProperty(OPENCODE_SESSION_HEADER);
  });

  test("does not send OpenCode headers to other providers", async () => {
    const calls: ProbeCall[] = [];
    await testInferenceConnection(CONNECTION, stubFetch(200, calls));
    expect(calls[0].headers).not.toHaveProperty(OPENCODE_SESSION_HEADER);
    expect(calls[0].headers).not.toHaveProperty(OPENCODE_REQUEST_HEADER);
  });

  test("skips when there is no base URL or no model to probe with", async () => {
    const neverFetch = (async () => {
      throw new Error("should not be called");
    }) as unknown as typeof fetch;
    expect(
      await testInferenceConnection(
        { ...CONNECTION, baseUrl: null },
        neverFetch,
      ),
    ).toBeNull();
    expect(
      await testInferenceConnection({ ...CONNECTION, models: [] }, neverFetch),
    ).toBeNull();
  });
});

import { describe, expect, test } from "bun:test";

import { testInferenceConnection } from "../endpoint-probe.js";

// Keyless auth so the probe never touches the vault; the fetch stub records
// the request instead of dialing out.
const CONNECTION = {
  provider: "openai-compatible",
  auth: { type: "none" } as const,
  baseUrl: "https://integrate.api.nvidia.com",
  models: [{ id: "meta/llama-3.1-8b-instruct" }],
};

function stubFetch(status: number, calls: { url: string; body: unknown }[]) {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body)),
    });
    return new Response(status < 400 ? "{}" : "404 page not found", { status });
  }) as typeof fetch;
}

describe("testInferenceConnection", () => {
  test("reports ok:false with a base-path hint on 404", async () => {
    const calls: { url: string; body: unknown }[] = [];
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
    const calls: { url: string; body: unknown }[] = [];
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

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

interface MockPlatformClient {
  platformAssistantId: string;
  fetch: ReturnType<typeof mock>;
}

let mockClient: MockPlatformClient | null = null;

mock.module("../../../platform/client.js", () => ({
  VellumPlatformClient: {
    create: async () => mockClient,
  },
}));

import { callManagedSearchProxy } from "../managed-search-proxy.js";

describe("callManagedSearchProxy", () => {
  beforeEach(() => {
    mockClient = {
      platformAssistantId: "asst-123",
      fetch: mock(async () => {
        return new Response(
          JSON.stringify({
            status: 200,
            headers: { "content-type": "application/json" },
            body: { web: { results: [] } },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    };
  });

  afterEach(() => {
    mockClient = null;
  });

  test("posts to the managed search proxy endpoint for the assistant and provider", async () => {
    await callManagedSearchProxy("brave", {
      method: "GET",
      path: "/res/v1/web/search",
    });

    expect(mockClient!.fetch).toHaveBeenCalledTimes(1);
    expect(mockClient!.fetch.mock.calls[0][0]).toBe(
      "/v1/assistants/asst-123/managed-search-proxy/brave/",
    );
  });

  test("encodes URL path segments", async () => {
    mockClient!.platformAssistantId = "asst/123";

    await callManagedSearchProxy("brave", {
      method: "GET",
      path: "/res/v1/web/search",
    });

    expect(mockClient!.fetch.mock.calls[0][0]).toBe(
      "/v1/assistants/asst%2F123/managed-search-proxy/brave/",
    );
  });

  test("sends the platform contract request envelope", async () => {
    await callManagedSearchProxy("brave", {
      method: "GET",
      path: "/res/v1/web/search",
      query: {
        q: "kimi k2 fireworks web search",
        count: "10",
        offset: "0",
        freshness: "pw",
      },
      headers: {
        Accept: "application/json",
      },
      body: null,
    });

    const init = mockClient!.fetch.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Content-Type")).toBe(
      "application/json",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      request: {
        method: "GET",
        path: "/res/v1/web/search",
        query: {
          q: "kimi k2 fireworks web search",
          count: "10",
          offset: "0",
          freshness: "pw",
        },
        headers: {
          Accept: "application/json",
        },
        body: null,
      },
    });
  });

  test("fills absent query, headers, and body with contract defaults", async () => {
    await callManagedSearchProxy("brave", {
      method: "GET",
      path: "/res/v1/web/search",
    });

    const init = mockClient!.fetch.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({
      request: {
        method: "GET",
        path: "/res/v1/web/search",
        query: {},
        headers: {},
        body: null,
      },
    });
  });

  test("passes the abort signal through to platform fetch", async () => {
    const controller = new AbortController();

    await callManagedSearchProxy(
      "brave",
      {
        method: "GET",
        path: "/res/v1/web/search",
      },
      controller.signal,
    );

    const init = mockClient!.fetch.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBe(controller.signal);
  });

  test("parses the response envelope and preserves provider JSON body", async () => {
    const providerBody = {
      web: {
        results: [{ title: "Result", url: "https://example.com" }],
      },
    };
    mockClient!.fetch = mock(async () => {
      return new Response(
        JSON.stringify({
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-request-id": "req-123",
          },
          body: providerBody,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await callManagedSearchProxy("brave", {
      method: "GET",
      path: "/res/v1/web/search",
    });

    expect(result).toEqual({
      ok: true,
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-request-id": "req-123",
      },
      body: providerBody,
    });
  });

  test("returns a typed platform error for non-2xx platform responses", async () => {
    mockClient!.fetch = mock(async () => {
      return new Response(
        JSON.stringify({ detail: "unsupported managed search provider" }),
        {
          status: 400,
          headers: {
            "content-type": "application/json",
            "x-platform-request-id": "platform-req-123",
          },
        },
      );
    });

    const result = await callManagedSearchProxy("brave", {
      method: "GET",
      path: "/res/v1/web/search",
    });

    expect(result).toEqual({
      ok: false,
      kind: "platform-error",
      status: 400,
      headers: {
        "content-type": "application/json",
        "x-platform-request-id": "platform-req-123",
      },
      body: { detail: "unsupported managed search provider" },
      message:
        "Managed search proxy returned status 400: unsupported managed search provider",
    });
  });

  test("preserves insufficient-balance platform errors", async () => {
    mockClient!.fetch = mock(async () => {
      return new Response(JSON.stringify({ detail: "Insufficient balance" }), {
        status: 402,
        headers: { "content-type": "application/json" },
      });
    });

    const result = await callManagedSearchProxy("brave", {
      method: "GET",
      path: "/res/v1/web/search",
    });

    expect(result).toEqual({
      ok: false,
      kind: "platform-error",
      status: 402,
      headers: {
        "content-type": "application/json",
      },
      body: { detail: "Insufficient balance" },
      message: "Managed search proxy returned status 402: Insufficient balance",
    });
  });

  test("returns unavailable when platform context is missing", async () => {
    mockClient = null;

    const result = await callManagedSearchProxy("brave", {
      method: "GET",
      path: "/res/v1/web/search",
    });

    expect(result).toEqual({
      ok: false,
      kind: "unavailable",
      message: "Managed search proxy is unavailable in this environment.",
    });
  });

  test("returns unavailable when platform assistant ID is missing", async () => {
    mockClient!.platformAssistantId = "";

    const result = await callManagedSearchProxy("brave", {
      method: "GET",
      path: "/res/v1/web/search",
    });

    expect(result).toEqual({
      ok: false,
      kind: "unavailable",
      message:
        "Managed search proxy is unavailable: platform assistant ID is missing.",
    });
  });

  test("returns an invalid-response result for malformed platform envelopes", async () => {
    mockClient!.fetch = mock(async () => {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const result = await callManagedSearchProxy("brave", {
      method: "GET",
      path: "/res/v1/web/search",
    });

    expect(result).toEqual({
      ok: false,
      kind: "invalid-response",
      body: { ok: true },
      message: "Managed search proxy returned an invalid response envelope.",
    });
  });
});

import { describe, expect, mock, test } from "bun:test";

import type { VellumPlatformClient } from "../platform/client.js";
import { BackendError, VellumError } from "../util/errors.js";
import {
  CredentialRequiredError,
  PlatformOAuthConnection,
  ProviderUnreachableError,
} from "./platform-connection.js";

function makeMockClient(
  fetchImpl?: typeof globalThis.fetch,
): VellumPlatformClient {
  const mockFetchFn =
    fetchImpl ??
    (mock(async () => {
      return new Response(
        JSON.stringify({ status: 200, headers: {}, body: null }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch);

  return {
    baseUrl: "https://platform.example.com",
    assistantApiKey: "test-api-key",
    platformAssistantId: "asst-abc",
    fetch: mock(async (path: string, init?: RequestInit) => {
      const url = `https://platform.example.com${path}`;
      const headers = new Headers(init?.headers);
      headers.set("Authorization", "Api-Key test-api-key");
      return mockFetchFn(url, { ...init, headers });
    }),
  } as unknown as VellumPlatformClient;
}

const DEFAULT_OPTIONS = {
  id: "conn-1",
  providerKey: "integration:google",
  externalId: "ext-123",
  accountInfo: "user@example.com",
  client: makeMockClient(),
  connectionId: "platform-conn-123",
};

describe("PlatformOAuthConnection", () => {
  test("successful proxied request", async () => {
    const upstreamBody = { messages: [{ id: "msg-1", snippet: "Hello" }] };

    const client = makeMockClient(
      mock(async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toBe(
          "https://platform.example.com/v1/assistants/asst-abc/external-provider-proxy/platform-conn-123/",
        );
        expect(init?.method).toBe("POST");
        const headers = new Headers(init?.headers);
        expect(headers.get("Authorization")).toBe("Api-Key test-api-key");
        expect(headers.get("Content-Type")).toBe("application/json");

        const parsed = JSON.parse(init?.body as string);
        expect(parsed).toEqual({
          request: {
            method: "GET",
            path: "/gmail/v1/users/me/messages",
            query: { maxResults: "10" },
            headers: {},
            body: null,
          },
        });

        return new Response(
          JSON.stringify({
            status: 200,
            headers: { "content-type": "application/json" },
            body: upstreamBody,
          }),
          { status: 200 },
        );
      }) as unknown as typeof globalThis.fetch,
    );

    const conn = new PlatformOAuthConnection({
      ...DEFAULT_OPTIONS,
      client,
    });
    const result = await conn.request({
      method: "GET",
      path: "/gmail/v1/users/me/messages",
      query: { maxResults: "10" },
    });

    expect(result.status).toBe(200);
    expect(result.headers).toEqual({ "content-type": "application/json" });
    expect(result.body).toEqual(upstreamBody);
  });

  test("forwards baseUrl when provided", async () => {
    const client = makeMockClient(
      mock(async (_url: string | URL | Request, init?: RequestInit) => {
        const parsed = JSON.parse(init?.body as string);
        expect(parsed.request.baseUrl).toBe(
          "https://www.googleapis.com/calendar/v3",
        );

        return new Response(
          JSON.stringify({ status: 200, headers: {}, body: {} }),
          { status: 200 },
        );
      }) as unknown as typeof globalThis.fetch,
    );

    const conn = new PlatformOAuthConnection({ ...DEFAULT_OPTIONS, client });
    await conn.request({
      method: "GET",
      path: "/calendars/primary/events",
      baseUrl: "https://www.googleapis.com/calendar/v3",
    });
  });

  test("omits baseUrl from envelope when not provided", async () => {
    const client = makeMockClient(
      mock(async (_url: string | URL | Request, init?: RequestInit) => {
        const parsed = JSON.parse(init?.body as string);
        expect("baseUrl" in parsed.request).toBe(false);

        return new Response(
          JSON.stringify({ status: 200, headers: {}, body: null }),
          { status: 200 },
        );
      }) as unknown as typeof globalThis.fetch,
    );

    const conn = new PlatformOAuthConnection({ ...DEFAULT_OPTIONS, client });
    await conn.request({ method: "GET", path: "/some/path" });
  });

  test("error classes extend VellumError hierarchy", () => {
    const credErr = new CredentialRequiredError();
    expect(credErr).toBeInstanceOf(BackendError);
    expect(credErr).toBeInstanceOf(VellumError);

    const provErr = new ProviderUnreachableError();
    expect(provErr).toBeInstanceOf(BackendError);
    expect(provErr).toBeInstanceOf(VellumError);
  });

  test("424 response throws CredentialRequiredError", async () => {
    const client = makeMockClient(
      mock(
        async () => new Response("", { status: 424 }),
      ) as unknown as typeof globalThis.fetch,
    );

    const conn = new PlatformOAuthConnection({ ...DEFAULT_OPTIONS, client });
    await expect(
      conn.request({ method: "GET", path: "/test" }),
    ).rejects.toThrow(CredentialRequiredError);
  });

  test("502 response throws ProviderUnreachableError", async () => {
    const client = makeMockClient(
      mock(
        async () => new Response("", { status: 502 }),
      ) as unknown as typeof globalThis.fetch,
    );

    const conn = new PlatformOAuthConnection({ ...DEFAULT_OPTIONS, client });
    await expect(
      conn.request({ method: "GET", path: "/test" }),
    ).rejects.toThrow(ProviderUnreachableError);
  });

  test("withToken throws clear error", async () => {
    const conn = new PlatformOAuthConnection(DEFAULT_OPTIONS);
    await expect(conn.withToken(async (token) => token)).rejects.toThrow(
      "Raw token access is not supported for platform-managed connections. Use connection.request() instead.",
    );
  });

  test("uses connectionId in proxy URL regardless of providerKey format", async () => {
    const client = makeMockClient(
      mock(async (url: string | URL | Request) => {
        expect(String(url)).toContain(
          "/external-provider-proxy/slack-conn-456/",
        );
        return new Response(
          JSON.stringify({ status: 200, headers: {}, body: null }),
          { status: 200 },
        );
      }) as unknown as typeof globalThis.fetch,
    );

    const conn = new PlatformOAuthConnection({
      ...DEFAULT_OPTIONS,
      client,
      providerKey: "integration:slack",
      connectionId: "slack-conn-456",
    });
    await conn.request({ method: "GET", path: "/test" });
  });
});

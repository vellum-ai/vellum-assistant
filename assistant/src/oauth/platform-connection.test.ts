import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { BackendError, VellumError } from "../util/errors.js";
import {
  CredentialRequiredError,
  PlatformOAuthConnection,
  ProviderUnreachableError,
} from "./platform-connection.js";

const DEFAULT_OPTIONS = {
  id: "conn-1",
  providerKey: "integration:google",
  externalId: "ext-123",
  accountInfo: "user@example.com",
  assistantId: "asst-abc",
  platformBaseUrl: "https://platform.example.com",
  apiKey: "test-api-key",
  connectionId: "platform-conn-123",
};

describe("PlatformOAuthConnection", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("successful proxied request", async () => {
    const upstreamBody = { messages: [{ id: "msg-1", snippet: "Hello" }] };

    globalThis.fetch = mock(
      async (url: string | URL | Request, init?: RequestInit) => {
        expect(url).toBe(
          "https://platform.example.com/v1/assistants/asst-abc/external-provider-proxy/platform-conn-123/",
        );
        expect(init?.method).toBe("POST");
        expect(init?.headers).toEqual({
          Authorization: "Api-Key test-api-key",
          "Content-Type": "application/json",
        });

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
      },
    ) as unknown as typeof globalThis.fetch;

    const conn = new PlatformOAuthConnection(DEFAULT_OPTIONS);
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
    globalThis.fetch = mock(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const parsed = JSON.parse(init?.body as string);
        expect(parsed.request.baseUrl).toBe(
          "https://www.googleapis.com/calendar/v3",
        );

        return new Response(
          JSON.stringify({ status: 200, headers: {}, body: {} }),
          { status: 200 },
        );
      },
    ) as unknown as typeof globalThis.fetch;

    const conn = new PlatformOAuthConnection(DEFAULT_OPTIONS);
    await conn.request({
      method: "GET",
      path: "/calendars/primary/events",
      baseUrl: "https://www.googleapis.com/calendar/v3",
    });
  });

  test("omits baseUrl from envelope when not provided", async () => {
    globalThis.fetch = mock(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const parsed = JSON.parse(init?.body as string);
        expect("baseUrl" in parsed.request).toBe(false);

        return new Response(
          JSON.stringify({ status: 200, headers: {}, body: null }),
          { status: 200 },
        );
      },
    ) as unknown as typeof globalThis.fetch;

    const conn = new PlatformOAuthConnection(DEFAULT_OPTIONS);
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
    globalThis.fetch = mock(async () => {
      return new Response("", { status: 424 });
    }) as unknown as typeof globalThis.fetch;

    const conn = new PlatformOAuthConnection(DEFAULT_OPTIONS);
    await expect(
      conn.request({ method: "GET", path: "/test" }),
    ).rejects.toThrow(CredentialRequiredError);
  });

  test("502 response throws ProviderUnreachableError", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("", { status: 502 });
    }) as unknown as typeof globalThis.fetch;

    const conn = new PlatformOAuthConnection(DEFAULT_OPTIONS);
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

  test("strips trailing slash from platformBaseUrl to avoid double slashes", async () => {
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      expect(String(url)).toBe(
        "https://platform.example.com/v1/assistants/asst-abc/external-provider-proxy/platform-conn-123/",
      );
      return new Response(
        JSON.stringify({ status: 200, headers: {}, body: null }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    const conn = new PlatformOAuthConnection({
      ...DEFAULT_OPTIONS,
      platformBaseUrl: "https://platform.example.com/",
    });
    await conn.request({ method: "GET", path: "/test" });
  });

  test("uses connectionId in proxy URL regardless of providerKey format", async () => {
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      expect(String(url)).toContain("/external-provider-proxy/slack-conn-456/");
      return new Response(
        JSON.stringify({ status: 200, headers: {}, body: null }),
        { status: 200 },
      );
    }) as unknown as typeof globalThis.fetch;

    const conn = new PlatformOAuthConnection({
      ...DEFAULT_OPTIONS,
      providerKey: "integration:slack",
      connectionId: "slack-conn-456",
    });
    await conn.request({ method: "GET", path: "/test" });
  });
});

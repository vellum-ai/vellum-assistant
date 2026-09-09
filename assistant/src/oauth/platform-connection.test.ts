import { describe, expect, mock, test } from "bun:test";

import * as actualRetry from "../util/retry.js";

// Stub out sleep so retry tests don't wait for real delays.
mock.module("../util/retry.js", () => ({
  ...actualRetry,
  sleep: () => Promise.resolve(),
}));

import type { VellumPlatformClient } from "../platform/client.js";
import { BackendError, VellumError } from "../util/errors.js";
import {
  CredentialRequiredError,
  InsufficientBalanceError,
  PlatformOAuthConnection,
  ProviderUnreachableError,
  unhonoredManagedOptions,
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
      headers.set("Authorization", "Bearer test-api-key");
      return mockFetchFn(url, { ...init, headers });
    }),
  } as unknown as VellumPlatformClient;
}

const DEFAULT_OPTIONS = {
  id: "conn-1",
  provider: "google",
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
        expect(headers.get("Authorization")).toBe("Bearer test-api-key");
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

  test("encodes a Buffer request body as base64 in the proxy envelope", async () => {
    const binary = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00,
    ]);

    const client = makeMockClient(
      mock(async (_url: string | URL | Request, init?: RequestInit) => {
        const parsed = JSON.parse(init?.body as string);
        expect(parsed.request.body).toBe(binary.toString("base64"));
        expect(parsed.request.body_encoding).toBe("base64");
        expect(parsed.request.headers["Content-Type"]).toBe("application/pdf");

        return new Response(
          JSON.stringify({
            status: 200,
            headers: { "content-type": "application/json" },
            body: { id: "file-123" },
          }),
          { status: 200 },
        );
      }) as unknown as typeof globalThis.fetch,
    );

    const conn = new PlatformOAuthConnection({
      ...DEFAULT_OPTIONS,
      client,
    });
    await conn.request({
      method: "POST",
      path: "/upload/drive/v3/files",
      headers: { "Content-Type": "application/pdf" },
      body: binary,
    });
  });

  test("decodes base64 binary proxy bodies into a Buffer", async () => {
    const binary = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00,
    ]);

    const client = makeMockClient(
      mock(async () => {
        return new Response(
          JSON.stringify({
            status: 200,
            headers: { "Content-Type": "application/octet-stream" },
            body: binary.toString("base64"),
            body_encoding: "base64",
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
      path: "/drive/v3/files/file-123",
      query: { alt: "media" },
    });

    expect(result.status).toBe(200);
    expect(Buffer.isBuffer(result.body)).toBe(true);
    expect(Buffer.from(result.body as Uint8Array).equals(binary)).toBe(true);
  });

  test("forwards per-request baseUrl when provided", async () => {
    const client = makeMockClient(
      mock(async (_url: string | URL | Request, init?: RequestInit) => {
        const parsed = JSON.parse(init?.body as string);
        expect(parsed.request.base_url).toBe(
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

  test("falls back to connection-level baseUrl when per-request baseUrl is absent", async () => {
    const client = makeMockClient(
      mock(async (_url: string | URL | Request, init?: RequestInit) => {
        const parsed = JSON.parse(init?.body as string);
        expect(parsed.request.base_url).toBe(
          "https://gmail.googleapis.com/gmail/v1/users/me",
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
      baseUrl: "https://gmail.googleapis.com/gmail/v1/users/me",
    });
    await conn.request({ method: "GET", path: "/messages" });
  });

  test("per-request baseUrl overrides connection-level baseUrl", async () => {
    const client = makeMockClient(
      mock(async (_url: string | URL | Request, init?: RequestInit) => {
        const parsed = JSON.parse(init?.body as string);
        expect(parsed.request.base_url).toBe(
          "https://www.googleapis.com/calendar/v3",
        );

        return new Response(
          JSON.stringify({ status: 200, headers: {}, body: {} }),
          { status: 200 },
        );
      }) as unknown as typeof globalThis.fetch,
    );

    const conn = new PlatformOAuthConnection({
      ...DEFAULT_OPTIONS,
      client,
      baseUrl: "https://gmail.googleapis.com/gmail/v1/users/me",
    });
    await conn.request({
      method: "GET",
      path: "/calendars/primary/events",
      baseUrl: "https://www.googleapis.com/calendar/v3",
    });
  });

  test("omits base_url from envelope when neither connection nor request provides one", async () => {
    const client = makeMockClient(
      mock(async (_url: string | URL | Request, init?: RequestInit) => {
        const parsed = JSON.parse(init?.body as string);
        expect("base_url" in parsed.request).toBe(false);

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

    const balErr = new InsufficientBalanceError();
    expect(balErr).toBeInstanceOf(BackendError);
    expect(balErr).toBeInstanceOf(VellumError);
  });

  test("402 response throws InsufficientBalanceError", async () => {
    const client = makeMockClient(
      mock(
        async () => new Response("", { status: 402 }),
      ) as unknown as typeof globalThis.fetch,
    );

    const conn = new PlatformOAuthConnection({ ...DEFAULT_OPTIONS, client });
    await expect(
      conn.request({ method: "GET", path: "/test" }),
    ).rejects.toThrow(InsufficientBalanceError);
  });

  test("402 response includes actionable billing message", async () => {
    const client = makeMockClient(
      mock(
        async () => new Response("", { status: 402 }),
      ) as unknown as typeof globalThis.fetch,
    );

    const conn = new PlatformOAuthConnection({ ...DEFAULT_OPTIONS, client });
    await expect(
      conn.request({ method: "GET", path: "/test" }),
    ).rejects.toThrow(/add funds/i);
  });

  test("does not retry on 402", async () => {
    let callCount = 0;
    const client = makeMockClient(
      mock(async () => {
        callCount++;
        return new Response("", { status: 402 });
      }) as unknown as typeof globalThis.fetch,
    );

    const conn = new PlatformOAuthConnection({ ...DEFAULT_OPTIONS, client });
    await expect(
      conn.request({ method: "GET", path: "/test" }),
    ).rejects.toThrow(InsufficientBalanceError);
    expect(callCount).toBe(1);
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

  test("502 response retries then throws ProviderUnreachableError", async () => {
    let callCount = 0;
    const client = makeMockClient(
      mock(async () => {
        callCount++;
        return new Response("", { status: 502 });
      }) as unknown as typeof globalThis.fetch,
    );

    const conn = new PlatformOAuthConnection({ ...DEFAULT_OPTIONS, client });
    await expect(
      conn.request({ method: "GET", path: "/test" }),
    ).rejects.toThrow(ProviderUnreachableError);
    // 1 initial + 3 retries = 4 total attempts
    expect(callCount).toBe(4);
  });

  test("502 response includes detail from response body", async () => {
    const client = makeMockClient(
      mock(
        async () => new Response("upstream timeout after 30s", { status: 502 }),
      ) as unknown as typeof globalThis.fetch,
    );

    const conn = new PlatformOAuthConnection({ ...DEFAULT_OPTIONS, client });
    await expect(
      conn.request({ method: "GET", path: "/test" }),
    ).rejects.toThrow(/upstream timeout after 30s/);
  });

  test("502 recovers on retry", async () => {
    let callCount = 0;
    const client = makeMockClient(
      mock(async () => {
        callCount++;
        if (callCount <= 2) {
          return new Response("", { status: 502 });
        }
        return new Response(
          JSON.stringify({ status: 200, headers: {}, body: { ok: true } }),
          { status: 200 },
        );
      }) as unknown as typeof globalThis.fetch,
    );

    const conn = new PlatformOAuthConnection({ ...DEFAULT_OPTIONS, client });
    const result = await conn.request({ method: "GET", path: "/test" });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true });
    expect(callCount).toBe(3);
  });

  test("withToken throws clear error", async () => {
    const conn = new PlatformOAuthConnection(DEFAULT_OPTIONS);
    await expect(conn.withToken(async (token) => token)).rejects.toThrow(
      "Raw token access is not supported for platform-managed connections. Use connection.request() instead.",
    );
  });

  test("retries on 429 and succeeds", async () => {
    let callCount = 0;
    const client = makeMockClient(
      mock(async () => {
        callCount++;
        if (callCount <= 2) {
          return new Response("", { status: 429 });
        }
        return new Response(
          JSON.stringify({ status: 200, headers: {}, body: { ok: true } }),
          { status: 200 },
        );
      }) as unknown as typeof globalThis.fetch,
    );

    const conn = new PlatformOAuthConnection({ ...DEFAULT_OPTIONS, client });
    const result = await conn.request({ method: "GET", path: "/test" });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true });
    expect(callCount).toBe(3);
  });

  test("throws after exhausting retries on 429", async () => {
    const client = makeMockClient(
      mock(
        async () => new Response("", { status: 429 }),
      ) as unknown as typeof globalThis.fetch,
    );

    const conn = new PlatformOAuthConnection({ ...DEFAULT_OPTIONS, client });
    await expect(
      conn.request({ method: "GET", path: "/test" }),
    ).rejects.toThrow("Platform proxy returned unexpected status 429");
  });

  test("retries on 500 and succeeds", async () => {
    let callCount = 0;
    const client = makeMockClient(
      mock(async () => {
        callCount++;
        if (callCount === 1) {
          return new Response("", { status: 500 });
        }
        return new Response(
          JSON.stringify({ status: 200, headers: {}, body: null }),
          { status: 200 },
        );
      }) as unknown as typeof globalThis.fetch,
    );

    const conn = new PlatformOAuthConnection({ ...DEFAULT_OPTIONS, client });
    const result = await conn.request({ method: "GET", path: "/test" });

    expect(result.status).toBe(200);
    expect(callCount).toBe(2);
  });

  test("does not retry on 424", async () => {
    let callCount = 0;
    const client = makeMockClient(
      mock(async () => {
        callCount++;
        return new Response("", { status: 424 });
      }) as unknown as typeof globalThis.fetch,
    );

    const conn = new PlatformOAuthConnection({ ...DEFAULT_OPTIONS, client });
    await expect(
      conn.request({ method: "GET", path: "/test" }),
    ).rejects.toThrow(CredentialRequiredError);
    expect(callCount).toBe(1);
  });

  test("does not retry on 403", async () => {
    let callCount = 0;
    const client = makeMockClient(
      mock(async () => {
        callCount++;
        return new Response("", { status: 403 });
      }) as unknown as typeof globalThis.fetch,
    );

    const conn = new PlatformOAuthConnection({ ...DEFAULT_OPTIONS, client });
    await expect(
      conn.request({ method: "GET", path: "/test" }),
    ).rejects.toThrow("Platform proxy returned unexpected status 403");
    expect(callCount).toBe(1);
  });

  test("singleAttempt makes one attempt on a retryable status", async () => {
    let callCount = 0;
    const client = makeMockClient(
      mock(async () => {
        callCount++;
        return new Response("", { status: 429 });
      }) as unknown as typeof globalThis.fetch,
    );

    const conn = new PlatformOAuthConnection({ ...DEFAULT_OPTIONS, client });
    await expect(
      conn.request({
        method: "POST",
        path: "/v1/payment_intents",
        singleAttempt: true,
      }),
    ).rejects.toThrow("Platform proxy returned unexpected status 429");
    expect(callCount).toBe(1);
  });

  test("singleAttempt does not replay a write after a 502", async () => {
    let callCount = 0;
    const client = makeMockClient(
      mock(async () => {
        callCount++;
        return new Response("", { status: 502 });
      }) as unknown as typeof globalThis.fetch,
    );

    const conn = new PlatformOAuthConnection({ ...DEFAULT_OPTIONS, client });
    await expect(
      conn.request({
        method: "POST",
        path: "/v1/payment_intents",
        singleAttempt: true,
      }),
    ).rejects.toThrow(ProviderUnreachableError);
    expect(callCount).toBe(1);
  });

  test("a POST without singleAttempt keeps retrying", async () => {
    let callCount = 0;
    const client = makeMockClient(
      mock(async () => {
        callCount++;
        if (callCount <= 2) {
          return new Response("", { status: 503 });
        }
        return new Response(
          JSON.stringify({ status: 200, headers: {}, body: { ok: true } }),
          { status: 200 },
        );
      }) as unknown as typeof globalThis.fetch,
    );

    const conn = new PlatformOAuthConnection({ ...DEFAULT_OPTIONS, client });
    const result = await conn.request({
      method: "POST",
      path: "/messages/send",
      body: { text: "hi" },
    });

    expect(result.body).toEqual({ ok: true });
    expect(callCount).toBe(3);
  });

  test("singleAttempt leaves a successful response untouched", async () => {
    let callCount = 0;
    const client = makeMockClient(
      mock(async () => {
        callCount++;
        return new Response(
          JSON.stringify({ status: 201, headers: {}, body: { id: "pi_1" } }),
          { status: 200 },
        );
      }) as unknown as typeof globalThis.fetch,
    );

    const conn = new PlatformOAuthConnection({ ...DEFAULT_OPTIONS, client });
    const result = await conn.request({
      method: "POST",
      path: "/v1/payment_intents",
      singleAttempt: true,
    });

    expect(result.status).toBe(201);
    expect(result.body).toEqual({ id: "pi_1" });
    expect(callCount).toBe(1);
  });

  test("an out-of-range envelope status fails instead of being clamped", async () => {
    const client = makeMockClient(
      mock(async () => {
        return new Response(
          JSON.stringify({ status: 700, headers: {}, body: { ok: true } }),
          { status: 200 },
        );
      }) as unknown as typeof globalThis.fetch,
    );

    // 700 reaches `new Response(body, { status })` as a RangeError, which is
    // not a mapped error, so the caller would see an opaque 500.
    const conn = new PlatformOAuthConnection({ ...DEFAULT_OPTIONS, client });
    await expect(conn.request({ method: "GET", path: "/x" })).rejects.toThrow(
      "Platform proxy returned an unusable response status: 700",
    );
  });

  test("a missing envelope status fails", async () => {
    const client = makeMockClient(
      mock(async () => {
        return new Response(JSON.stringify({ headers: {}, body: null }), {
          status: 200,
        });
      }) as unknown as typeof globalThis.fetch,
    );

    const conn = new PlatformOAuthConnection({ ...DEFAULT_OPTIONS, client });
    await expect(conn.request({ method: "GET", path: "/x" })).rejects.toThrow(
      BackendError,
    );
  });

  // The platform proxy rebuilds the query from the parsed record, so managed
  // mode cannot carry a signed query string.
  test("sends the parsed query and never rawQuery", async () => {
    const client = makeMockClient(
      mock(async (_url: string | URL | Request, init?: RequestInit) => {
        const parsed = JSON.parse(init?.body as string);
        expect(parsed.request.query).toEqual({ a: "1" });
        expect("rawQuery" in parsed.request).toBe(false);
        expect("raw_query" in parsed.request).toBe(false);

        return new Response(
          JSON.stringify({ status: 200, headers: {}, body: null }),
          { status: 200 },
        );
      }) as unknown as typeof globalThis.fetch,
    );

    const conn = new PlatformOAuthConnection({ ...DEFAULT_OPTIONS, client });
    await conn.request({
      method: "GET",
      path: "/x",
      query: { a: "1" },
      rawQuery: "?a=1&flag",
    });
  });

  // The platform proxy parses the response, rebuilds the query, and follows
  // redirects server-side, so managed mode diverges from BYO on all three by
  // design.
  test("names every option the platform proxy cannot honor", () => {
    expect(unhonoredManagedOptions({ method: "GET", path: "/x" })).toEqual([]);
    expect(
      unhonoredManagedOptions({
        method: "GET",
        path: "/x",
        rawResponseBody: true,
        manualRedirect: true,
        rawQuery: "?a=1&flag",
      }),
    ).toEqual(["rawResponseBody", "manualRedirect", "rawQuery"]);
  });

  test("an empty rawQuery asks for no fidelity to lose", () => {
    expect(
      unhonoredManagedOptions({ method: "GET", path: "/x", rawQuery: "" }),
    ).toEqual([]);
  });

  test("manualRedirect neither errors nor reaches the proxy envelope", async () => {
    const client = makeMockClient(
      mock(async (_url: string | URL | Request, init?: RequestInit) => {
        const parsed = JSON.parse(init?.body as string);
        expect("manual_redirect" in parsed.request).toBe(false);
        expect("redirect" in parsed.request).toBe(false);

        return new Response(
          JSON.stringify({
            status: 200,
            headers: { "content-type": "application/json" },
            body: { followed: true },
          }),
          { status: 200 },
        );
      }) as unknown as typeof globalThis.fetch,
    );

    const conn = new PlatformOAuthConnection({ ...DEFAULT_OPTIONS, client });
    const result = await conn.request({
      method: "GET",
      path: "/v1/redirecting",
      manualRedirect: true,
      rawResponseBody: true,
    });

    // The platform already followed the redirect and parsed the body, so the
    // caller sees the destination's JSON rather than a 3xx or raw bytes.
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ followed: true });
  });

  test("uses connectionId in proxy URL regardless of provider format", async () => {
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
      provider: "slack",
      connectionId: "slack-conn-456",
    });
    await conn.request({ method: "GET", path: "/test" });
  });
});

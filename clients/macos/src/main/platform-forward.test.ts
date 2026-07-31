import { describe, expect, test } from "bun:test";

import {
  buildProxyNetworkErrorResponse,
  fetchForwardPlanWithRetry,
  isTransientNetworkError,
  planPlatformForward,
  PROXY_ERROR_HEADER,
  PROXY_NETWORK_ERROR_CODE,
} from "./platform-forward";

const PLATFORM = "https://platform.vellum.ai";
const ELECTRON_RENDERER_ORIGIN_HEADER = "X-Vellum-Electron-Renderer-Origin";

const request = (
  pathname: string,
  init: { method?: string; origin?: string; headers?: Record<string, string> } = {},
) => ({
  url: `app://vellum.ai${pathname}`,
  method: init.method ?? "GET",
  headers: new Headers({
    ...(init.origin !== undefined ? { origin: init.origin } : {}),
    ...init.headers,
  }),
});

describe("planPlatformForward", () => {
  test("passes non-platform requests through to static serving", () => {
    expect(
      planPlatformForward(request("/assistant/assets/app.js"), PLATFORM),
    ).toEqual({ kind: "pass" });
  });

  test("passes gateway requests through", () => {
    expect(
      planPlatformForward(request("/__gateway/8080/v1/foo"), PLATFORM),
    ).toEqual({ kind: "pass" });
  });

  test("forwards /v1/* requests to platform", () => {
    const plan = planPlatformForward(
      request("/v1/assistants"),
      PLATFORM,
    );
    expect(plan.kind).toBe("forward");
    if (plan.kind !== "forward") throw new Error("expected forward");
    expect(plan.url).toBe("https://platform.vellum.ai/v1/assistants");
    expect(plan.method).toBe("GET");
    expect(plan.hasBody).toBe(false);
  });

  test("forwards /_allauth/* requests to platform", () => {
    const plan = planPlatformForward(
      request("/_allauth/browser/v1/auth/session"),
      PLATFORM,
    );
    if (plan.kind !== "forward") throw new Error("expected forward");
    expect(plan.url).toBe(
      "https://platform.vellum.ai/_allauth/browser/v1/auth/session",
    );
  });

  test("forwards /accounts/* requests to platform", () => {
    const plan = planPlatformForward(
      request("/accounts/login"),
      PLATFORM,
    );
    if (plan.kind !== "forward") throw new Error("expected forward");
    expect(plan.url).toBe("https://platform.vellum.ai/accounts/login");
  });

  test("forwards exact prefix without trailing slash", () => {
    const plan = planPlatformForward(request("/v1"), PLATFORM);
    if (plan.kind !== "forward") throw new Error("expected forward");
    expect(plan.url).toBe("https://platform.vellum.ai/v1");
  });

  test("preserves query string on forwarded requests", () => {
    const plan = planPlatformForward(
      request("/v1/assistants?page=2&limit=10"),
      PLATFORM,
    );
    if (plan.kind !== "forward") throw new Error("expected forward");
    expect(plan.url).toBe(
      "https://platform.vellum.ai/v1/assistants?page=2&limit=10",
    );
  });

  test("rewrites Origin from app:// to platform origin", () => {
    const plan = planPlatformForward(
      request("/v1/assistants", { origin: "app://vellum.ai" }),
      PLATFORM,
    );
    if (plan.kind !== "forward") throw new Error("expected forward");
    expect(plan.headers.get("origin")).toBe("https://platform.vellum.ai");
  });

  test("sets a platform Origin even when the renderer sent none", () => {
    const plan = planPlatformForward(request("/v1/assistants"), PLATFORM);
    if (plan.kind !== "forward") throw new Error("expected forward");
    expect(plan.headers.get("origin")).toBe("https://platform.vellum.ai");
  });

  test("forwards unsafe requests from the trusted app origin", () => {
    const plan = planPlatformForward(
      request("/_allauth/browser/v1/auth/session", {
        method: "POST",
        origin: "app://vellum.ai",
      }),
      PLATFORM,
      { allowedOrigin: { protocol: "app:", host: "vellum.ai" } },
    );
    if (plan.kind !== "forward") throw new Error("expected forward");
    expect(plan.headers.get("origin")).toBe("https://platform.vellum.ai");
  });

  test("rejects platform requests with a foreign Origin", () => {
    const plan = planPlatformForward(
      request("/_allauth/browser/v1/auth/session", {
        method: "POST",
        origin: "https://evil.example",
      }),
      PLATFORM,
      { allowedOrigin: { protocol: "app:", host: "vellum.ai" } },
    );

    expect(plan).toEqual({
      kind: "reject",
      status: 403,
      message: "Forbidden platform proxy request",
    });
  });

  test("rejects platform requests with a foreign Referer when Origin is absent", () => {
    const plan = planPlatformForward(
      request("/_allauth/browser/v1/auth/session", {
        method: "POST",
        headers: { referer: "https://evil.example/form" },
      }),
      PLATFORM,
      { allowedOrigin: { protocol: "app:", host: "vellum.ai" } },
    );

    expect(plan.kind).toBe("reject");
  });

  test("trusts source-less unsafe requests with renderer-origin marker", () => {
    const plan = planPlatformForward(
      request("/v1/assistants", {
        method: "POST",
        headers: { [ELECTRON_RENDERER_ORIGIN_HEADER]: "app://vellum.ai" },
      }),
      PLATFORM,
      { allowedOrigin: { protocol: "app:", host: "vellum.ai" } },
    );

    if (plan.kind !== "forward") throw new Error("expected forward");
    expect(plan.headers.get("origin")).toBe("https://platform.vellum.ai");
    expect(plan.headers.get(ELECTRON_RENDERER_ORIGIN_HEADER)).toBeNull();
  });

  test("trusts source-less unsafe requests with Sec-Fetch-Site same-origin", () => {
    const plan = planPlatformForward(
      request("/v1/assistants", {
        method: "POST",
        headers: { "sec-fetch-site": "same-origin" },
      }),
      PLATFORM,
      { allowedOrigin: { protocol: "app:", host: "vellum.ai" } },
    );

    if (plan.kind !== "forward") throw new Error("expected forward");
  });

  test("rejects source-less unsafe requests with cross-site fetch metadata", () => {
    const plan = planPlatformForward(
      request("/v1/assistants", {
        method: "POST",
        headers: { "sec-fetch-site": "cross-site" },
      }),
      PLATFORM,
      { allowedOrigin: { protocol: "app:", host: "vellum.ai" } },
    );

    expect(plan.kind).toBe("reject");
  });

  test("rejects source-less unsafe requests without any trust signal", () => {
    const plan = planPlatformForward(
      request("/v1/assistants", { method: "POST" }),
      PLATFORM,
      { allowedOrigin: { protocol: "app:", host: "vellum.ai" } },
    );

    expect(plan.kind).toBe("reject");
  });

  test("rejects source-less unsafe requests from a foreign request URL", () => {
    const plan = planPlatformForward(
      {
        url: "app://evil.example/v1/assistants",
        method: "POST",
        headers: new Headers({
          [ELECTRON_RENDERER_ORIGIN_HEADER]: "app://vellum.ai",
        }),
      },
      PLATFORM,
      { allowedOrigin: { protocol: "app:", host: "vellum.ai" } },
    );

    expect(plan.kind).toBe("reject");
  });

  test("forwards source-less safe platform requests", () => {
    const plan = planPlatformForward(
      request("/v1/assistants", { method: "GET" }),
      PLATFORM,
      { allowedOrigin: { protocol: "app:", host: "vellum.ai" } },
    );

    expect(plan.kind).toBe("forward");
  });

  test("preserves non-Origin headers", () => {
    const plan = planPlatformForward(
      request("/_allauth/browser/v1/auth/session", {
        method: "POST",
        origin: "app://vellum.ai",
        headers: {
          authorization: "Bearer api-token",
          "content-type": "application/json",
          "x-csrftoken": "csrf123",
        },
      }),
      PLATFORM,
    );
    if (plan.kind !== "forward") throw new Error("expected forward");
    expect(plan.headers.get("authorization")).toBe("Bearer api-token");
    expect(plan.headers.get("content-type")).toBe("application/json");
    expect(plan.headers.get("x-csrftoken")).toBe("csrf123");
  });

  test("marks POST/PUT/PATCH/DELETE as hasBody, GET/HEAD as no body", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const plan = planPlatformForward(
        request("/v1/assistants", { method }),
        PLATFORM,
      );
      if (plan.kind !== "forward") throw new Error("expected forward");
      expect(plan.hasBody).toBe(true);
    }
    for (const method of ["GET", "HEAD"]) {
      const plan = planPlatformForward(
        request("/v1/assistants", { method }),
        PLATFORM,
      );
      if (plan.kind !== "forward") throw new Error("expected forward");
      expect(plan.hasBody).toBe(false);
    }
  });

  test("works with custom platform URL (staging)", () => {
    const plan = planPlatformForward(
      request("/v1/assistants"),
      "https://staging-platform.vellum.ai",
    );
    if (plan.kind !== "forward") throw new Error("expected forward");
    expect(plan.url).toBe(
      "https://staging-platform.vellum.ai/v1/assistants",
    );
    expect(plan.headers.get("origin")).toBe(
      "https://staging-platform.vellum.ai",
    );
  });

  test("works with local platform URL", () => {
    const plan = planPlatformForward(
      request("/v1/assistants"),
      "http://localhost:8000",
    );
    if (plan.kind !== "forward") throw new Error("expected forward");
    expect(plan.url).toBe("http://localhost:8000/v1/assistants");
    expect(plan.headers.get("origin")).toBe("http://localhost:8000");
  });

  test("does not forward paths that merely start with a prefix string", () => {
    expect(
      planPlatformForward(request("/v1something/else"), PLATFORM),
    ).toEqual({ kind: "pass" });

    expect(
      planPlatformForward(request("/accountsettings"), PLATFORM),
    ).toEqual({ kind: "pass" });
  });
});

// ---------------------------------------------------------------------------
// Transient-failure retry + structured proxy error (LUM-2402)
// ---------------------------------------------------------------------------

describe("isTransientNetworkError", () => {
  test("matches Chromium transient net errors", () => {
    for (const code of [
      "ERR_NETWORK_CHANGED",
      "ERR_INTERNET_DISCONNECTED",
      "ERR_NAME_NOT_RESOLVED",
      "ERR_CONNECTION_RESET",
    ]) {
      expect(isTransientNetworkError(new Error(`net::${code}`))).toBe(true);
    }
  });

  test("rejects other errors and non-Error values", () => {
    expect(isTransientNetworkError(new Error("net::ERR_CERT_INVALID"))).toBe(
      false,
    );
    expect(isTransientNetworkError(new Error("boom"))).toBe(false);
    expect(isTransientNetworkError("ERR_NETWORK_CHANGED")).toBe(false);
    expect(isTransientNetworkError(undefined)).toBe(false);
  });
});

describe("buildProxyNetworkErrorResponse", () => {
  test("returns a structured JSON 502 with the marker header", async () => {
    const response = buildProxyNetworkErrorResponse();
    expect(response.status).toBe(502);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get(PROXY_ERROR_HEADER)).toBe("network");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.code).toBe(PROXY_NETWORK_ERROR_CODE);
    expect(typeof body.detail).toBe("string");
    expect(body.detail).not.toContain("net::");
  });
});

describe("fetchForwardPlanWithRetry", () => {
  const noSleep = async () => {};
  const get = { method: "GET", hasBody: false };
  const post = { method: "POST", hasBody: true };

  test("retries a GET through a transient failure and returns the eventual success", async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const response = await fetchForwardPlanWithRetry(
      get,
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("net::ERR_NETWORK_CHANGED");
        return new Response("ok", { status: 200 });
      },
      {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );

    expect(response.status).toBe(200);
    expect(attempts).toBe(2);
    expect(sleeps).toEqual([500]);
  });

  test("returns the structured 502 after exhausting retries", async () => {
    let attempts = 0;
    const response = await fetchForwardPlanWithRetry(
      get,
      async () => {
        attempts += 1;
        throw new Error("net::ERR_NETWORK_CHANGED");
      },
      { retries: 2, sleep: noSleep },
    );

    expect(attempts).toBe(3);
    expect(response.status).toBe(502);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.code).toBe(PROXY_NETWORK_ERROR_CODE);
  });

  test("does not retry requests with a body — their stream is single-use", async () => {
    let attempts = 0;
    const response = await fetchForwardPlanWithRetry(
      post,
      async () => {
        attempts += 1;
        throw new Error("net::ERR_NETWORK_CHANGED");
      },
      { sleep: noSleep },
    );

    expect(attempts).toBe(1);
    expect(response.status).toBe(502);
  });

  test("does not retry non-transient failures", async () => {
    let attempts = 0;
    const response = await fetchForwardPlanWithRetry(
      get,
      async () => {
        attempts += 1;
        throw new Error("net::ERR_CERT_AUTHORITY_INVALID");
      },
      { sleep: noSleep },
    );

    expect(attempts).toBe(1);
    expect(response.status).toBe(502);
  });

  test("reports every failed attempt to onError", async () => {
    const seen: number[] = [];
    await fetchForwardPlanWithRetry(
      get,
      async () => {
        throw new Error("net::ERR_CONNECTION_RESET");
      },
      {
        retries: 1,
        sleep: noSleep,
        onError: (_err, attempt) => {
          seen.push(attempt);
        },
      },
    );

    expect(seen).toEqual([0, 1]);
  });

  test("a successful response passes through untouched on the first attempt", async () => {
    const upstream = new Response("hello", { status: 201 });
    const response = await fetchForwardPlanWithRetry(get, async () => upstream, {
      sleep: noSleep,
    });
    expect(response).toBe(upstream);
  });
});

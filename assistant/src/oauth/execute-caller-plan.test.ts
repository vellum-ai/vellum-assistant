import { describe, expect, mock, test } from "bun:test";

import type { VellumPlatformClient } from "../platform/client.js";
import type {
  OAuthDirectCallerPlan,
  OAuthPlatformProxyCallerPlan,
} from "./caller-plan.js";
import {
  executeOAuthCallerPlan,
  runPreparedOAuthRequest,
  shouldRetryDirectPlanOnUnauthorized,
} from "./execute-caller-plan.js";

function directPlan(
  overrides: Partial<OAuthDirectCallerPlan> = {},
): OAuthDirectCallerPlan {
  return {
    mode: "direct",
    method: "GET",
    url: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
    headers: { Authorization: "Bearer tok-1" },
    authScheme: "Bearer",
    account: "user@example.com",
    ...overrides,
  };
}

function platformPlan(): OAuthPlatformProxyCallerPlan {
  return {
    mode: "platform_proxy",
    proxyPath:
      "/v1/assistants/asst-abc/external-provider-proxy/platform-conn-123/",
    envelope: {
      request: {
        method: "GET",
        path: "/gmail/v1/users/me/messages",
        query: {},
        headers: {},
        body: null,
      },
    },
    account: "user@example.com",
  };
}

describe("shouldRetryDirectPlanOnUnauthorized", () => {
  test("retries BYO Bearer 401s", () => {
    expect(shouldRetryDirectPlanOnUnauthorized(directPlan(), 401)).toBe(true);
  });

  test("does not retry Telegram (authScheme none)", () => {
    expect(
      shouldRetryDirectPlanOnUnauthorized(
        directPlan({ authScheme: "none" }),
        401,
      ),
    ).toBe(false);
  });

  test("does not retry platform proxy 401s", () => {
    expect(shouldRetryDirectPlanOnUnauthorized(platformPlan(), 401)).toBe(
      false,
    );
  });
});

describe("executeOAuthCallerPlan", () => {
  test("direct plan fetches and parses JSON in this process", async () => {
    const fetchFn = mock(async (url: string | URL | Request) => {
      expect(String(url)).toBe(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages",
      );
      return new Response(JSON.stringify({ messages: [{ id: "m1" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const result = await executeOAuthCallerPlan(directPlan(), { fetchFn });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ messages: [{ id: "m1" }] });
  });

  test("platform plan uses the injected platform client, not a raw provider URL", async () => {
    const fetchFn = mock(async () => {
      throw new Error("direct fetch should not run for platform_proxy");
    }) as unknown as typeof fetch;

    const clientFetch = mock(async (path: string) => {
      expect(path).toBe(
        "/v1/assistants/asst-abc/external-provider-proxy/platform-conn-123/",
      );
      return new Response(
        JSON.stringify({
          status: 200,
          headers: { "content-type": "application/json" },
          body: { messages: [{ id: "m1" }] },
        }),
        { status: 200 },
      );
    });

    const result = await executeOAuthCallerPlan(platformPlan(), {
      fetchFn,
      createPlatformClient: async () =>
        ({
          fetch: clientFetch,
        }) as unknown as VellumPlatformClient,
    });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ messages: [{ id: "m1" }] });
    expect(clientFetch).toHaveBeenCalledTimes(1);
  });

  test("platform plan fails closed when the platform client is unavailable", async () => {
    await expect(
      executeOAuthCallerPlan(platformPlan(), {
        createPlatformClient: async () => null,
      }),
    ).rejects.toThrow(/Not connected to Vellum platform/);
  });
});

describe("runPreparedOAuthRequest", () => {
  test("re-prepares once after a BYO 401", async () => {
    const prepares: boolean[] = [];
    const execute = mock(async (plan: { headers: Record<string, string> }) => {
      if (plan.headers.Authorization === "Bearer tok-1") {
        return { status: 401, headers: {}, body: "expired" };
      }
      return { status: 200, headers: {}, body: { ok: true } };
    });

    const result = await runPreparedOAuthRequest({
      prepare: async (forceRefresh) => {
        prepares.push(forceRefresh);
        return directPlan({
          headers: {
            Authorization: forceRefresh ? "Bearer tok-2" : "Bearer tok-1",
          },
        });
      },
      execute: execute as never,
    });

    expect(prepares).toEqual([false, true]);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.response.status).toBe(200);
    expect(result.response.body).toEqual({ ok: true });
  });

  test("does not re-prepare Telegram 401s", async () => {
    const prepares: boolean[] = [];
    const result = await runPreparedOAuthRequest({
      prepare: async (forceRefresh) => {
        prepares.push(forceRefresh);
        return directPlan({ authScheme: "none" });
      },
      execute: async () => ({ status: 401, headers: {}, body: "unauthorized" }),
    });

    expect(prepares).toEqual([false]);
    expect(result.response.status).toBe(401);
  });
});

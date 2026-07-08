import { afterEach, describe, expect, mock, test } from "bun:test";

import { clearGatewayToken, getGatewayToken } from "@/lib/auth/gateway-session";
import {
  activateRemoteGatewaySession,
  createRemoteWebPairingChallenge,
  exchangeRemoteWebPairingToken,
  parseRemoteWebPairingParams,
  refreshRemoteGatewaySession,
  remoteGatewayApiPath,
  remoteGatewayPublicPathPrefix,
  RemoteWebPairingError,
} from "@/lib/auth/remote-gateway-session";
import {
  getSelfHostedActorToken,
  getSelfHostedIngressUrl,
  setSelfHostedConnection,
} from "@/lib/self-hosted/connection";

const realFetch = globalThis.fetch;

function setLocation(path: string): void {
  window.history.pushState(null, "", `http://localhost:3000${path}`);
}

afterEach(() => {
  globalThis.fetch = realFetch;
  window.__VELLUM_CONFIG__ = undefined;
  clearGatewayToken();
  setSelfHostedConnection(null);
  localStorage.clear();
  setLocation("/assistant/pair");
});

describe("remote web pairing link parsing", () => {
  test("accepts camelCase query parameters", () => {
    const params = parseRemoteWebPairingParams(
      "https://paired.example.com/assistant/pair?deviceCode=device-1&userCode=ABCD-EFGH",
    );

    expect(params).toEqual({
      deviceCode: "device-1",
      userCode: "ABCD-EFGH",
    });
  });

  test("accepts snake_case hash parameters", () => {
    const params = parseRemoteWebPairingParams(
      "https://paired.example.com/assistant/pair#device_code=device-2&user_code=WXYZ-1234",
    );

    expect(params).toEqual({
      deviceCode: "device-2",
      userCode: "WXYZ-1234",
    });
  });
});

describe("remote gateway public prefix", () => {
  test("uses bare gateway paths at /assistant", () => {
    setLocation("/assistant/pair");

    expect(remoteGatewayPublicPathPrefix()).toBe("");
    expect(remoteGatewayApiPath("/v1/guardian/refresh")).toBe(
      "/v1/guardian/refresh",
    );
  });

  test("preserves a public path prefix before /assistant", () => {
    setLocation("/assistant-123/assistant/pair");

    expect(remoteGatewayPublicPathPrefix()).toBe("/assistant-123");
    expect(remoteGatewayApiPath("/v1/guardian/refresh")).toBe(
      "/assistant-123/v1/guardian/refresh",
    );
  });
});

describe("remote gateway token exchange", () => {
  test("creates browser pairing challenges against the remote gateway", async () => {
    setLocation("/assistant-123/assistant");
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (input, init) => {
      calls.push({ input, init });
      return Response.json({
        deviceCode: "device-code",
        userCode: "B8C2-S2J3",
        verificationUri: "http://localhost:3000/assistant-123/assistant/pair",
        expiresAt: "2026-06-16T12:00:00.000Z",
        expiresInSeconds: 600,
        intervalSeconds: 5,
      });
    }) as unknown as typeof fetch;

    await expect(createRemoteWebPairingChallenge()).resolves.toEqual({
      deviceCode: "device-code",
      userCode: "B8C2-S2J3",
      verificationUri: "http://localhost:3000/assistant-123/assistant/pair",
      expiresAt: "2026-06-16T12:00:00.000Z",
      expiresInSeconds: 600,
      intervalSeconds: 5,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].input).toBe(
      "/assistant-123/v1/remote-web/pairing-challenge",
    );
    expect(calls[0].init?.credentials).toBe("include");
    expect(calls[0].init?.body).toBe(
      JSON.stringify({
        publicBaseUrl: "http://localhost:3000/assistant-123",
      }),
    );
  });

  test("surfaces a non-JSON challenge error as a RemoteWebPairingError, not a parse error", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response("<html><body>502</body></html>", {
          status: 502,
          headers: { "Content-Type": "text/html" },
        }),
    ) as unknown as typeof fetch;

    const error = await createRemoteWebPairingChallenge().catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RemoteWebPairingError);
    expect((error as RemoteWebPairingError).status).toBe(502);
  });

  test("surfaces a non-JSON token-exchange error as a RemoteWebPairingError, not a parse error", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response("<html><body>502</body></html>", {
          status: 502,
          headers: { "Content-Type": "text/html" },
        }),
    ) as unknown as typeof fetch;

    const error = await exchangeRemoteWebPairingToken("device-code").catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RemoteWebPairingError);
    expect((error as RemoteWebPairingError).status).toBe(502);
    expect((error as RemoteWebPairingError).code).toBeNull();
  });

  test("surfaces the error body code on a repair-required token-exchange failure", async () => {
    globalThis.fetch = mock(async () =>
      Response.json(
        {
          error: {
            code: "GUARDIAN_REPAIR_REQUIRED",
            message: "gateway guardian binding is missing",
          },
        },
        { status: 503 },
      ),
    ) as unknown as typeof fetch;

    const error = await exchangeRemoteWebPairingToken("device-code").catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RemoteWebPairingError);
    expect((error as RemoteWebPairingError).status).toBe(503);
    expect((error as RemoteWebPairingError).code).toBe(
      "GUARDIAN_REPAIR_REQUIRED",
    );
  });

  test("posts the device code with cookie credentials", async () => {
    setLocation("/assistant-123/assistant/pair");
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (input, init) => {
      calls.push({ input, init });
      return Response.json(
        {
          status: "pending",
          expiresAt: "2026-06-16T12:00:00.000Z",
          intervalSeconds: 7,
        },
        { status: 202 },
      );
    }) as unknown as typeof fetch;

    await expect(exchangeRemoteWebPairingToken("device-code")).resolves.toEqual(
      {
        status: "pending",
        expiresAt: "2026-06-16T12:00:00.000Z",
        intervalSeconds: 7,
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].input).toBe("/assistant-123/v1/remote-web/pairing-token");
    expect(calls[0].init?.credentials).toBe("include");
    expect(calls[0].init?.body).toBe(
      JSON.stringify({ deviceCode: "device-code" }),
    );
  });

  test("stores approved access tokens in memory and primes self-hosted routing", () => {
    window.__VELLUM_CONFIG__ = { mode: "remote-gateway" };
    setLocation("/assistant-123/assistant/pair");

    activateRemoteGatewaySession({
      status: "approved",
      accessToken: "access-token",
      accessTokenExpiresAt: "2999-01-01T00:00:00.000Z",
      refreshAfter: "2999-01-01T00:00:00.000Z",
    });

    expect(getGatewayToken()).toBe("access-token");
    expect(getSelfHostedIngressUrl()).toBe(
      "http://localhost:3000/assistant-123",
    );
    expect(getSelfHostedActorToken()).toBe("access-token");
    expect(localStorage.getItem("vellum:gw:token")).toBeNull();
  });

  test("does not rotate the refresh cookie before refreshAfter", async () => {
    window.__VELLUM_CONFIG__ = { mode: "remote-gateway" };
    setLocation("/assistant-123/assistant/conversations/self");
    globalThis.fetch = mock(async () =>
      Response.json({}),
    ) as unknown as typeof fetch;

    activateRemoteGatewaySession({
      status: "approved",
      accessToken: "access-token",
      accessTokenExpiresAt: "2999-01-01T00:00:00.000Z",
      refreshAfter: "2999-01-01T00:00:00.000Z",
    });

    await expect(refreshRemoteGatewaySession()).resolves.toBe(true);

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(getGatewayToken()).toBe("access-token");
  });

  test("refreshes from the HttpOnly cookie endpoint", async () => {
    window.__VELLUM_CONFIG__ = { mode: "remote-gateway" };
    setLocation("/assistant-123/assistant/conversations/self");
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (input, init) => {
      calls.push({ input, init });
      return Response.json({
        guardianPrincipalId: "guardian-1",
        accessToken: "refreshed-access-token",
        accessTokenExpiresAt: Date.parse("2999-01-01T00:00:00.000Z"),
        refreshAfter: Date.parse("2999-01-01T00:00:00.000Z"),
      });
    }) as unknown as typeof fetch;

    await expect(refreshRemoteGatewaySession()).resolves.toBe(true);

    expect(calls).toHaveLength(1);
    expect(calls[0].input).toBe("/assistant-123/v1/guardian/refresh");
    expect(calls[0].init?.credentials).toBe("include");
    expect(calls[0].init?.body).toBe("{}");
    expect(getGatewayToken()).toBe("refreshed-access-token");
  });

  test("shares concurrent same-tab refresh attempts", async () => {
    window.__VELLUM_CONFIG__ = { mode: "remote-gateway" };
    setLocation("/assistant-123/assistant/conversations/self");
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    globalThis.fetch = mock(async (input, init) => {
      calls.push({ input, init });
      await refreshGate;
      return Response.json({
        guardianPrincipalId: "guardian-1",
        accessToken: "shared-access-token",
        accessTokenExpiresAt: Date.parse("2999-01-01T00:00:00.000Z"),
        refreshAfter: Date.parse("2999-01-01T00:00:00.000Z"),
      });
    }) as unknown as typeof fetch;

    const first = refreshRemoteGatewaySession();
    const second = refreshRemoteGatewaySession();

    expect(calls).toHaveLength(1);
    releaseRefresh();
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);

    expect(calls).toHaveLength(1);
    expect(getGatewayToken()).toBe("shared-access-token");
  });
});

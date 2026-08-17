import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  GatewayTokenError,
  clearGatewayToken,
  ensureGatewayToken,
  getGatewayToken,
  isGatewayAuthEnabled,
  isGatewayAuthMode,
  isRepairableGatewayTokenError,
  seedGatewayToken,
  setRemoteGatewayToken,
} from "@/lib/auth/gateway-session";
import { setSelfHostedConnection } from "@/lib/self-hosted/connection";
import type { LockfileAssistant } from "@/runtime/local-mode-host";
import { useLockfileStore } from "@/stores/lockfile-store";

const realFetch = globalThis.fetch;

function selectLocalWithToken(): void {
  process.env.VITE_PLATFORM_MODE = "";
  const local = {
    assistantId: "local-a",
    cloud: "local",
    resources: { gatewayPort: 20100 },
  } as LockfileAssistant;
  useLockfileStore.setState({
    lockfile: { assistants: [local], activeAssistant: "local-a" },
  });
  seedGatewayToken({
    token: "current-token",
    expiresAtEpochSeconds: 9_999_999_999,
    source: "/assistant/__gateway/20100/auth/token",
  });
}

beforeEach(() => {
  // The token cache is module-level; start every test with no cached token so
  // `ensureGatewayToken` always reaches the mint.
  clearGatewayToken();
});

afterEach(() => {
  window.__VELLUM_CONFIG__ = undefined;
  globalThis.fetch = realFetch;
  clearGatewayToken();
  setSelfHostedConnection(null);
  useLockfileStore.setState({ lockfile: null, committed: false });
  process.env.VITE_PLATFORM_MODE = "true";
});

describe("remote gateway mode", () => {
  test("is enabled but not active until an in-memory token exists", () => {
    window.__VELLUM_CONFIG__ = { mode: "remote-gateway" };

    expect(isGatewayAuthEnabled()).toBe(true);
    expect(isGatewayAuthMode()).toBe(false);

    setRemoteGatewayToken({
      accessToken: "remote-token",
      accessTokenExpiresAt: "2999-01-01T00:00:00.000Z",
    });

    expect(isGatewayAuthMode()).toBe(true);
  });
});

describe("paired selection", () => {
  function selectPaired(runtimeUrl?: string): void {
    const paired = {
      assistantId: "paired-a",
      cloud: "paired",
      ...(runtimeUrl != null && { runtimeUrl }),
    } as LockfileAssistant;
    useLockfileStore.setState({
      lockfile: { assistants: [paired], activeAssistant: "paired-a" },
    });
  }

  test("gateway auth is enabled for a paired selection with a usable runtimeUrl", () => {
    process.env.VITE_PLATFORM_MODE = "";
    selectPaired("https://gw.example.com");

    expect(isGatewayAuthEnabled()).toBe(true);
  });

  test("gateway auth stays disabled when the paired runtimeUrl is unusable", () => {
    process.env.VITE_PLATFORM_MODE = "";
    selectPaired();

    expect(isGatewayAuthEnabled()).toBe(false);
  });

  test("gateway auth stays disabled for a paired selection outside local mode", () => {
    selectPaired("https://gw.example.com");

    expect(isGatewayAuthEnabled()).toBe(false);
  });

  test("paired auth mode requires a host-primed proxy connection", () => {
    process.env.VITE_PLATFORM_MODE = "";
    selectPaired("https://gw.example.com");
    const fetchSpy = mock(async () => {
      throw new Error("unexpected fetch");
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    expect(isGatewayAuthMode()).toBe(false);

    setSelfHostedConnection({
      url: `${window.location.origin}/assistant/__gateway-paired/paired-a`,
      token: null,
    });

    expect(isGatewayAuthMode()).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("paired auth mode rejects a primed connection for another assistant", () => {
    process.env.VITE_PLATFORM_MODE = "";
    selectPaired("https://gw.example.com");
    setSelfHostedConnection({
      url: `${window.location.origin}/assistant/__gateway-paired/paired-b`,
      token: null,
    });

    expect(isGatewayAuthMode()).toBe(false);
  });
});

describe("ensureGatewayToken mint failure", () => {
  test("throws a GatewayTokenError carrying the response status on a 401", async () => {
    globalThis.fetch = mock(async () => ({
      ok: false,
      status: 401,
    })) as unknown as typeof fetch;

    const err = await ensureGatewayToken(
      "/assistant/__gateway/20100/auth/token",
      "guardian-token",
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GatewayTokenError);
    expect((err as GatewayTokenError).status).toBe(401);
  });

  test("preserves a non-401 status (e.g. 403 boundary refusal)", async () => {
    globalThis.fetch = mock(async () => ({
      ok: false,
      status: 403,
    })) as unknown as typeof fetch;

    const err = await ensureGatewayToken(
      "/assistant/__gateway/20100/auth/token",
      "guardian-token",
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GatewayTokenError);
    expect((err as GatewayTokenError).status).toBe(403);
  });

  test("returns the minted token on success", async () => {
    globalThis.fetch = mock(async () => ({
      ok: true,
      json: async () => ({ token: "minted", expiresAt: 9_999_999_999 }),
    })) as unknown as typeof fetch;

    const token = await ensureGatewayToken(
      "/assistant/__gateway/20100/auth/token",
      "guardian-token",
    );
    expect(token).toBe("minted");
  });
});

describe("ensureGatewayToken replacement minting", () => {
  test("keeps the active session available until its replacement is minted", async () => {
    selectLocalWithToken();

    let finishMint: (() => void) | undefined;
    globalThis.fetch = mock(
      () =>
        new Promise<Response>((resolve) => {
          finishMint = () =>
            resolve(
              Response.json({
                token: "replacement-token",
                expiresAt: 9_999_999_999,
              }),
            );
        }),
    ) as unknown as typeof fetch;

    const refresh = ensureGatewayToken(
      "/assistant/__gateway/20101/auth/token",
      "guardian-token",
      { forceMint: true },
    );

    expect(isGatewayAuthMode()).toBe(true);
    finishMint?.();
    await expect(refresh).resolves.toBe("replacement-token");
    expect(isGatewayAuthMode()).toBe(true);
  });

  test("keeps the active session when replacement minting fails", async () => {
    selectLocalWithToken();
    globalThis.fetch = mock(
      async () => new Response(null, { status: 503 }),
    ) as unknown as typeof fetch;

    await expect(
      ensureGatewayToken(
        "/assistant/__gateway/20101/auth/token",
        "guardian-token",
        { forceMint: true },
      ),
    ).rejects.toBeInstanceOf(GatewayTokenError);

    expect(isGatewayAuthMode()).toBe(true);
  });

  test("leaves a replacement uninstalled for caller-controlled commit", async () => {
    selectLocalWithToken();
    const deferredTokens: Parameters<typeof seedGatewayToken>[0][] = [];
    globalThis.fetch = mock(async () =>
      Response.json({
        token: "replacement-token",
        expiresAt: 9_999_999_999,
      }),
    ) as unknown as typeof fetch;

    await expect(
      ensureGatewayToken(
        "/assistant/__gateway/20101/auth/token",
        "guardian-token",
        {
          commit: (token) => deferredTokens.push(token),
        },
      ),
    ).resolves.toBe("replacement-token");

    expect(getGatewayToken()).toBe("current-token");
    expect(deferredTokens).toEqual([
      {
        token: "replacement-token",
        expiresAtEpochSeconds: 9_999_999_999,
        source: "/assistant/__gateway/20101/auth/token",
      },
    ]);
  });
});

describe("isRepairableGatewayTokenError", () => {
  test("true only for a 401 GatewayTokenError", () => {
    expect(isRepairableGatewayTokenError(new GatewayTokenError(401, "x"))).toBe(
      true,
    );
  });

  test("false for a 403 (boundary refusal) and 5xx (transient)", () => {
    expect(isRepairableGatewayTokenError(new GatewayTokenError(403, "x"))).toBe(
      false,
    );
    expect(isRepairableGatewayTokenError(new GatewayTokenError(500, "x"))).toBe(
      false,
    );
  });

  test("false for a plain Error or a non-error value", () => {
    expect(isRepairableGatewayTokenError(new Error("nope"))).toBe(false);
    expect(isRepairableGatewayTokenError(undefined)).toBe(false);
  });
});

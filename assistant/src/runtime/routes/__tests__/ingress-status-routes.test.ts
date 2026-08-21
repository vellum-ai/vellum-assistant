/**
 * Unit tests for the integrations_ingress_status route handler.
 *
 * The workspace config reads and the probe are both mocked, so the five
 * states are exercised without a config file or network access.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { LastTunnelRecord } from "../../../daemon/handlers/config-ingress.js";
import type { TunnelProbeResult } from "../../../inbound/tunnel-probe.js";
import { ACTOR_PRINCIPALS } from "../../auth/route-policy.js";

let ingressConfig = {
  enabled: false,
  publicBaseUrl: "",
  localGatewayTarget: "http://127.0.0.1:4000",
  managedCallbacks: false,
  success: true,
};
let lastTunnel: LastTunnelRecord | null = null;
let recordedAssistantId: string | null = null;
let probeResult: TunnelProbeResult = { kind: "healthy" };

const probeTunnelMock = mock(
  async (_args: {
    publicBaseUrl: string;
    expectedAssistantId?: string;
  }): Promise<TunnelProbeResult> => probeResult,
);

mock.module("../../../daemon/handlers/config-ingress.js", () => ({
  getIngressConfigResult: () => ingressConfig,
  loadLastTunnelRecord: () => lastTunnel,
  loadRecordedAssistantId: () => recordedAssistantId,
}));

mock.module("../../../inbound/tunnel-probe.js", () => ({
  probeTunnel: probeTunnelMock,
}));

import { ROUTES } from "../ingress-status-routes.js";

const route = ROUTES.find(
  (r) => r.operationId === "integrations_ingress_status",
)!;

const TUNNEL_URL = "https://assistant-1.example.ts.net";

describe("integrations_ingress_status route", () => {
  beforeEach(() => {
    ingressConfig = {
      enabled: false,
      publicBaseUrl: "",
      localGatewayTarget: "http://127.0.0.1:4000",
      managedCallbacks: false,
      success: true,
    };
    lastTunnel = null;
    recordedAssistantId = null;
    probeResult = { kind: "healthy" };
    probeTunnelMock.mockClear();
  });

  test("is registered with the expected operationId, method, and endpoint", () => {
    expect(route).toBeDefined();
    expect(route.method).toBe("GET");
    expect(route.endpoint).toBe("integrations/ingress/status");
    expect(route.policy).toEqual({
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    });
  });

  test("reports unconfigured for a platform-hosted assistant", async () => {
    ingressConfig = {
      ...ingressConfig,
      enabled: true,
      publicBaseUrl: "https://platform.example.com/gateway/callbacks/a-1",
      managedCallbacks: true,
    };
    lastTunnel = { provider: "tailscale", publicBaseUrl: TUNNEL_URL };

    expect(await route.handler({})).toEqual({ state: "unconfigured" });
    expect(probeTunnelMock).not.toHaveBeenCalled();
  });

  test("reports unconfigured with no URL and no recorded tunnel", async () => {
    expect(await route.handler({})).toEqual({ state: "unconfigured" });
    expect(probeTunnelMock).not.toHaveBeenCalled();
  });

  test("reports stopped with the recorded tunnel when the URL is gone", async () => {
    lastTunnel = { provider: "tailscale", publicBaseUrl: TUNNEL_URL };

    expect(await route.handler({})).toEqual({
      state: "stopped",
      lastTunnel: { provider: "tailscale", publicBaseUrl: TUNNEL_URL },
    });
    expect(probeTunnelMock).not.toHaveBeenCalled();
  });

  test("reports healthy with a timestamp when the probe succeeds", async () => {
    ingressConfig = {
      ...ingressConfig,
      enabled: true,
      publicBaseUrl: TUNNEL_URL,
    };
    recordedAssistantId = "assistant-1";

    const result = (await route.handler({})) as Record<string, unknown>;

    expect(result.state).toBe("healthy");
    expect(result.publicBaseUrl).toBe(TUNNEL_URL);
    expect(new Date(result.checkedAt as string).getTime()).not.toBeNaN();
    expect(probeTunnelMock).toHaveBeenCalledWith({
      publicBaseUrl: TUNNEL_URL,
      expectedAssistantId: "assistant-1",
    });
  });

  test("omits expectedAssistantId when no id was recorded", async () => {
    ingressConfig = {
      ...ingressConfig,
      enabled: true,
      publicBaseUrl: TUNNEL_URL,
    };

    await route.handler({});

    expect(probeTunnelMock).toHaveBeenCalledWith({
      publicBaseUrl: TUNNEL_URL,
    });
  });

  test("reports unreachable with the probe's detail", async () => {
    ingressConfig = {
      ...ingressConfig,
      enabled: true,
      publicBaseUrl: TUNNEL_URL,
    };
    probeResult = { kind: "unreachable", detail: "HTTP 502" };

    const result = (await route.handler({})) as Record<string, unknown>;

    expect(result.state).toBe("unreachable");
    expect(result.detail).toBe("HTTP 502");
    expect(result.publicBaseUrl).toBe(TUNNEL_URL);
    expect(result.checkedAt).toBeString();
  });

  test("reports foreign with the name the edge serves under", async () => {
    ingressConfig = {
      ...ingressConfig,
      enabled: true,
      publicBaseUrl: TUNNEL_URL,
    };
    recordedAssistantId = "assistant-1";
    probeResult = {
      kind: "foreign",
      assistantId: "assistant-2",
      assistantName: "Other Assistant",
    };

    const result = (await route.handler({})) as Record<string, unknown>;

    expect(result.state).toBe("foreign");
    expect(result.servingAssistantName).toBe("Other Assistant");
    expect(result.publicBaseUrl).toBe(TUNNEL_URL);
  });

  test("omits servingAssistantName when the edge reports no name", async () => {
    ingressConfig = {
      ...ingressConfig,
      enabled: true,
      publicBaseUrl: TUNNEL_URL,
    };
    probeResult = { kind: "foreign", assistantId: "assistant-2" };

    const result = (await route.handler({})) as Record<string, unknown>;

    expect(result.state).toBe("foreign");
    expect(result).not.toHaveProperty("servingAssistantName");
  });

  test("treats a whitespace-only URL as no URL", async () => {
    ingressConfig = { ...ingressConfig, enabled: true, publicBaseUrl: "   " };

    expect(await route.handler({})).toEqual({ state: "unconfigured" });
    expect(probeTunnelMock).not.toHaveBeenCalled();
  });
});

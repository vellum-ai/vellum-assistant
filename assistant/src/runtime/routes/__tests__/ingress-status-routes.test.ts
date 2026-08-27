/**
 * Unit tests for the integrations_ingress_status route handler.
 *
 * The workspace config reads and the probe are both mocked, so the six
 * states are exercised without a config file or network access.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { TunnelRecord } from "@vellumai/service-contracts/ingress";

import type { TunnelProbeResult } from "../../../inbound/tunnel-probe.js";
import { ACTOR_PRINCIPALS } from "../../auth/route-policy.js";

let ingressConfig = {
  enabled: true,
  explicitlyDisabled: false,
  publicBaseUrl: "",
  localGatewayTarget: "http://127.0.0.1:4000",
  managedCallbacks: false,
  success: true,
};
let velayManaged = false;
let lastTunnel: TunnelRecord | null = null;
let pairingTunnel: TunnelRecord | null = null;
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
  isVelayManagedIngress: () => velayManaged,
  loadPairingTunnelRecord: () => pairingTunnel,
  // Mirrors the real selector: a pairing-only record wins over the last run.
  loadRestartTunnelRecord: () => pairingTunnel ?? lastTunnel,
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
const PAIRING_URL = "https://assistant-1.pairing.example.ts.net";

describe("integrations_ingress_status route", () => {
  beforeEach(() => {
    ingressConfig = {
      enabled: true,
      explicitlyDisabled: false,
      publicBaseUrl: "",
      localGatewayTarget: "http://127.0.0.1:4000",
      managedCallbacks: false,
      success: true,
    };
    velayManaged = false;
    lastTunnel = null;
    pairingTunnel = null;
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
      publicBaseUrl: "https://platform.example.com/gateway/callbacks/a-1",
      managedCallbacks: true,
    };
    lastTunnel = { provider: "tailscale", publicBaseUrl: TUNNEL_URL };

    expect(await route.handler({})).toEqual({ state: "unconfigured" });
    expect(probeTunnelMock).not.toHaveBeenCalled();
  });

  test("reports unconfigured with no URL and no recorded tunnel", async () => {
    ingressConfig = { ...ingressConfig, publicBaseUrl: "" };

    expect(await route.handler({})).toEqual({ state: "unconfigured" });
    expect(probeTunnelMock).not.toHaveBeenCalled();
  });

  test("reports stopped with the recorded tunnel when the URL is gone", async () => {
    ingressConfig = { ...ingressConfig, publicBaseUrl: "" };
    lastTunnel = { provider: "tailscale", publicBaseUrl: TUNNEL_URL };

    expect(await route.handler({})).toEqual({
      state: "stopped",
      lastTunnel: { provider: "tailscale", publicBaseUrl: TUNNEL_URL },
    });
    expect(probeTunnelMock).not.toHaveBeenCalled();
  });

  test("reports stopped without probing when ingress is switched off", async () => {
    ingressConfig = {
      ...ingressConfig,
      enabled: false,
      explicitlyDisabled: true,
      publicBaseUrl: TUNNEL_URL,
    };
    lastTunnel = { provider: "tailscale", publicBaseUrl: TUNNEL_URL };

    expect(await route.handler({})).toEqual({
      state: "stopped",
      lastTunnel: { provider: "tailscale", publicBaseUrl: TUNNEL_URL },
    });
    expect(probeTunnelMock).not.toHaveBeenCalled();
  });

  test("reports stopped for a disabled URL with no recorded tunnel", async () => {
    ingressConfig = {
      ...ingressConfig,
      enabled: false,
      explicitlyDisabled: true,
      publicBaseUrl: TUNNEL_URL,
    };

    expect(await route.handler({})).toEqual({ state: "stopped" });
    expect(probeTunnelMock).not.toHaveBeenCalled();
  });

  test("probes a URL configured without the enabled flag", async () => {
    // A bring-your-own-HTTPS front is set up with `config set
    // ingress.publicBaseUrl`, which never writes `ingress.enabled`. Only an
    // explicit opt-out means stopped.
    ingressConfig = {
      ...ingressConfig,
      enabled: false,
      explicitlyDisabled: false,
      publicBaseUrl: TUNNEL_URL,
    };

    const result = (await route.handler({})) as Record<string, unknown>;

    expect(result.state).toBe("healthy");
    expect(probeTunnelMock).toHaveBeenCalledWith({
      publicBaseUrl: TUNNEL_URL,
    });
  });

  test("reports healthy with a timestamp when the probe succeeds", async () => {
    ingressConfig = { ...ingressConfig, publicBaseUrl: TUNNEL_URL };
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
    ingressConfig = { ...ingressConfig, publicBaseUrl: TUNNEL_URL };

    await route.handler({});

    expect(probeTunnelMock).toHaveBeenCalledWith({
      publicBaseUrl: TUNNEL_URL,
    });
  });

  test("reports unreachable with the probe's detail", async () => {
    ingressConfig = { ...ingressConfig, publicBaseUrl: TUNNEL_URL };
    probeResult = { kind: "unreachable", detail: "HTTP 502" };

    const result = (await route.handler({})) as Record<string, unknown>;

    expect(result.state).toBe("unreachable");
    expect(result.detail).toBe("HTTP 502");
    expect(result.publicBaseUrl).toBe(TUNNEL_URL);
    expect(result.checkedAt).toBeString();
  });

  test("reports unpairable with the probe's detail", async () => {
    ingressConfig = { ...ingressConfig, publicBaseUrl: TUNNEL_URL };
    probeResult = { kind: "unpairable", detail: "HTTP 404" };

    const result = (await route.handler({})) as Record<string, unknown>;

    expect(result.state).toBe("unpairable");
    expect(result.detail).toBe("HTTP 404");
    expect(result.publicBaseUrl).toBe(TUNNEL_URL);
    expect(result.checkedAt).toBeString();
  });

  test("omits the detail when the unpairable edge gave no reason", async () => {
    ingressConfig = { ...ingressConfig, publicBaseUrl: TUNNEL_URL };
    probeResult = { kind: "unpairable" };

    const result = (await route.handler({})) as Record<string, unknown>;

    expect(result.state).toBe("unpairable");
    expect(result).not.toHaveProperty("detail");
  });

  test("names the tunnel to restart when the URL cannot pair", async () => {
    // Same remedy as an unreachable address: start a tunnel that serves the
    // web app in front of this assistant.
    ingressConfig = { ...ingressConfig, publicBaseUrl: TUNNEL_URL };
    lastTunnel = { provider: "tailscale", publicBaseUrl: TUNNEL_URL };
    probeResult = { kind: "unpairable", detail: "HTTP 404" };

    const result = (await route.handler({})) as Record<string, unknown>;

    expect(result.state).toBe("unpairable");
    expect(result.lastTunnel).toEqual({
      provider: "tailscale",
      publicBaseUrl: TUNNEL_URL,
    });
  });

  test("reports foreign with the name the edge serves under", async () => {
    ingressConfig = { ...ingressConfig, publicBaseUrl: TUNNEL_URL };
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
    ingressConfig = { ...ingressConfig, publicBaseUrl: TUNNEL_URL };
    probeResult = { kind: "foreign", assistantId: "assistant-2" };

    const result = (await route.handler({})) as Record<string, unknown>;

    expect(result.state).toBe("foreign");
    expect(result).not.toHaveProperty("servingAssistantName");
  });

  test("names the tunnel to restart when the URL is unreachable", async () => {
    ingressConfig = { ...ingressConfig, publicBaseUrl: TUNNEL_URL };
    lastTunnel = { provider: "ngrok", publicBaseUrl: TUNNEL_URL };
    probeResult = { kind: "unreachable", detail: "HTTP 502" };

    const result = (await route.handler({})) as Record<string, unknown>;

    expect(result.state).toBe("unreachable");
    expect(result.lastTunnel).toEqual({
      provider: "ngrok",
      publicBaseUrl: TUNNEL_URL,
    });
  });

  test("names the tunnel to restart when the URL is foreign", async () => {
    ingressConfig = { ...ingressConfig, publicBaseUrl: TUNNEL_URL };
    lastTunnel = { provider: "ngrok", publicBaseUrl: TUNNEL_URL };
    probeResult = { kind: "foreign", assistantId: "assistant-2" };

    const result = (await route.handler({})) as Record<string, unknown>;

    expect(result.state).toBe("foreign");
    expect(result.lastTunnel).toEqual({
      provider: "ngrok",
      publicBaseUrl: TUNNEL_URL,
    });
  });

  test("ignores trailing slashes when matching the recorded tunnel", async () => {
    ingressConfig = { ...ingressConfig, publicBaseUrl: `${TUNNEL_URL}/` };
    lastTunnel = { provider: "ngrok", publicBaseUrl: TUNNEL_URL };
    probeResult = { kind: "unreachable", detail: "HTTP 502" };

    const result = (await route.handler({})) as Record<string, unknown>;

    expect(result.lastTunnel).toEqual({
      provider: "ngrok",
      publicBaseUrl: TUNNEL_URL,
    });
  });

  test("omits a recorded tunnel that fronted a different URL", async () => {
    // `saveIngressUrl` keeps `lastTunnel` when it replaces the URL without a
    // provider, so the record can outlive the address it described. Restarting
    // it would not bring the configured URL back.
    ingressConfig = { ...ingressConfig, publicBaseUrl: TUNNEL_URL };
    lastTunnel = { provider: "ngrok", publicBaseUrl: "https://old.ngrok.app" };
    probeResult = { kind: "unreachable", detail: "HTTP 502" };

    const result = (await route.handler({})) as Record<string, unknown>;

    expect(result.state).toBe("unreachable");
    expect(result).not.toHaveProperty("lastTunnel");
  });

  test("omits a stale recorded tunnel from a foreign response", async () => {
    ingressConfig = { ...ingressConfig, publicBaseUrl: TUNNEL_URL };
    lastTunnel = { provider: "ngrok", publicBaseUrl: "https://old.ngrok.app" };
    probeResult = { kind: "foreign", assistantId: "assistant-2" };

    const result = (await route.handler({})) as Record<string, unknown>;

    expect(result.state).toBe("foreign");
    expect(result).not.toHaveProperty("lastTunnel");
  });

  test("reports unconfigured for a Velay-managed ingress with no URL", async () => {
    // The gateway clears the URL when its tunnel drops and reconnects on its
    // own, so there is no tunnel command to offer the user.
    velayManaged = true;
    ingressConfig = { ...ingressConfig, publicBaseUrl: "" };
    lastTunnel = { provider: "ngrok", publicBaseUrl: TUNNEL_URL };

    expect(await route.handler({})).toEqual({ state: "unconfigured" });
    expect(probeTunnelMock).not.toHaveBeenCalled();
  });

  test("reports a Velay-managed URL with no pairing tunnel as unconfigured", async () => {
    // Velay's allowlist (`gateway/src/velay/allowed-paths.ts`) carries neither
    // `/healthz` nor the pairing surface, so the callback URL it owns could
    // only ever probe as dead. The card asks for a first tunnel instead.
    velayManaged = true;
    ingressConfig = { ...ingressConfig, publicBaseUrl: TUNNEL_URL };
    lastTunnel = { provider: "ngrok", publicBaseUrl: TUNNEL_URL };

    expect(await route.handler({})).toEqual({ state: "unconfigured" });
    expect(probeTunnelMock).not.toHaveBeenCalled();
  });

  test("omits lastTunnel from a healthy response", async () => {
    ingressConfig = { ...ingressConfig, publicBaseUrl: TUNNEL_URL };
    lastTunnel = { provider: "ngrok", publicBaseUrl: TUNNEL_URL };

    const result = (await route.handler({})) as Record<string, unknown>;

    expect(result.state).toBe("healthy");
    expect(result).not.toHaveProperty("lastTunnel");
  });

  test("probes the pairing tunnel over the webhook callback base", async () => {
    // `vellum tunnel --provider tailscale` beside configured webhooks leaves
    // the callback base alone, so the address the user started for pairing is
    // the one this route exists to report on.
    ingressConfig = {
      ...ingressConfig,
      publicBaseUrl: "https://webhooks.ngrok.app",
    };
    pairingTunnel = { provider: "tailscale", publicBaseUrl: PAIRING_URL };
    lastTunnel = {
      provider: "ngrok",
      publicBaseUrl: "https://webhooks.ngrok.app",
    };
    recordedAssistantId = "assistant-1";

    const result = (await route.handler({})) as Record<string, unknown>;

    expect(result.state).toBe("healthy");
    expect(result.publicBaseUrl).toBe(PAIRING_URL);
    expect(probeTunnelMock).toHaveBeenCalledWith({
      publicBaseUrl: PAIRING_URL,
      expectedAssistantId: "assistant-1",
    });
  });

  test("names the pairing tunnel to restart when its address is dead", async () => {
    ingressConfig = {
      ...ingressConfig,
      publicBaseUrl: "https://webhooks.ngrok.app",
    };
    pairingTunnel = { provider: "tailscale", publicBaseUrl: PAIRING_URL };
    lastTunnel = {
      provider: "ngrok",
      publicBaseUrl: "https://webhooks.ngrok.app",
    };
    probeResult = { kind: "unreachable", detail: "HTTP 502" };

    const result = (await route.handler({})) as Record<string, unknown>;

    expect(result.state).toBe("unreachable");
    expect(result.publicBaseUrl).toBe(PAIRING_URL);
    expect(result.lastTunnel).toEqual({
      provider: "tailscale",
      publicBaseUrl: PAIRING_URL,
    });
  });

  test("probes the pairing tunnel while callback ingress is switched off", async () => {
    // `ingress.enabled` governs webhook callbacks. `vellum tunnel --provider
    // tailscale` records a pairing tunnel without touching it, so the opt-out
    // must not discard the address the command just established.
    ingressConfig = {
      ...ingressConfig,
      enabled: false,
      explicitlyDisabled: true,
      publicBaseUrl: "https://webhooks.ngrok.app",
    };
    pairingTunnel = { provider: "tailscale", publicBaseUrl: PAIRING_URL };

    const result = (await route.handler({})) as Record<string, unknown>;

    expect(result.state).toBe("healthy");
    expect(result.publicBaseUrl).toBe(PAIRING_URL);
    expect(probeTunnelMock).toHaveBeenCalledWith({
      publicBaseUrl: PAIRING_URL,
    });
  });

  test("probes a pairing tunnel recorded without a callback base", async () => {
    ingressConfig = { ...ingressConfig, publicBaseUrl: "" };
    pairingTunnel = { provider: "tailscale", publicBaseUrl: PAIRING_URL };

    const result = (await route.handler({})) as Record<string, unknown>;

    expect(result.state).toBe("healthy");
    expect(result.publicBaseUrl).toBe(PAIRING_URL);
  });

  test("prefers the pairing tunnel over a Velay-managed callback base", async () => {
    // Velay owns the callback URL, not the tailnet address the user started
    // for pairing, and the Velay URL exposes neither `/healthz` nor the
    // pairing surface (`gateway/src/velay/allowed-paths.ts`).
    velayManaged = true;
    ingressConfig = { ...ingressConfig, publicBaseUrl: TUNNEL_URL };
    pairingTunnel = { provider: "tailscale", publicBaseUrl: PAIRING_URL };

    const result = (await route.handler({})) as Record<string, unknown>;

    expect(result.publicBaseUrl).toBe(PAIRING_URL);
    expect(probeTunnelMock).toHaveBeenCalledWith({
      publicBaseUrl: PAIRING_URL,
    });
  });

  test("probes a Velay-managed ingress only through its pairing tunnel", async () => {
    // The pairing record is the one address on a Velay-managed workspace that
    // a device can reach, so it is probed while the callback base is not.
    velayManaged = true;
    ingressConfig = { ...ingressConfig, publicBaseUrl: TUNNEL_URL };
    pairingTunnel = { provider: "tailscale", publicBaseUrl: PAIRING_URL };
    recordedAssistantId = "assistant-1";

    const result = (await route.handler({})) as Record<string, unknown>;

    expect(result.state).toBe("healthy");
    expect(result.publicBaseUrl).toBe(PAIRING_URL);
    expect(probeTunnelMock).toHaveBeenCalledTimes(1);
    expect(probeTunnelMock).toHaveBeenCalledWith({
      publicBaseUrl: PAIRING_URL,
      expectedAssistantId: "assistant-1",
    });
  });

  test("names the pairing tunnel to restart on a Velay-managed ingress", async () => {
    // The restart guidance Velay must never get is for its own ingress; the
    // pairing tunnel beside it is the user's to start again.
    velayManaged = true;
    ingressConfig = { ...ingressConfig, publicBaseUrl: TUNNEL_URL };
    pairingTunnel = { provider: "tailscale", publicBaseUrl: PAIRING_URL };
    probeResult = { kind: "unreachable", detail: "HTTP 502" };

    const result = (await route.handler({})) as Record<string, unknown>;

    expect(result.state).toBe("unreachable");
    expect(result.lastTunnel).toEqual({
      provider: "tailscale",
      publicBaseUrl: PAIRING_URL,
    });
  });

  test("reports the configured URL when no pairing tunnel is recorded", async () => {
    ingressConfig = { ...ingressConfig, publicBaseUrl: TUNNEL_URL };
    lastTunnel = { provider: "ngrok", publicBaseUrl: TUNNEL_URL };

    const result = (await route.handler({})) as Record<string, unknown>;

    expect(result.state).toBe("healthy");
    expect(result.publicBaseUrl).toBe(TUNNEL_URL);
  });

  test("treats a whitespace-only URL as no URL", async () => {
    ingressConfig = { ...ingressConfig, publicBaseUrl: "   " };

    expect(await route.handler({})).toEqual({ state: "unconfigured" });
    expect(probeTunnelMock).not.toHaveBeenCalled();
  });
});

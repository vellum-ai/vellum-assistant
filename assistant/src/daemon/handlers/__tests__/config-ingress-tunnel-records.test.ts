/**
 * Unit tests for the ingress section of the workspace config: the records
 * `vellum tunnel` leaves behind, who owns the public base URL, and when the
 * records are dropped. The record truth table lives on the shared parser
 * (`packages/service-contracts/src/__tests__/ingress.test.ts`); what is
 * checked here is that the daemon reads the keys the CLI and the gateway
 * write, and inherits that validation.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

let rawConfig: Record<string, unknown> = {};

mock.module("../../../config/loader.js", () => ({
  loadRawConfig: () => rawConfig,
}));

import {
  dropTunnelRecordsForNewUrl,
  getIngressConfigResult,
  isVelayManagedIngress,
  loadLastTunnelRecord,
  loadPairingTunnelRecord,
  loadRecordedAssistantId,
} from "../config-ingress.js";

const TUNNEL_URL = "https://assistant-1.example.ts.net";
const PAIRING_URL = "https://assistant-1.pairing.example.ts.net";

describe("workspace tunnel records", () => {
  beforeEach(() => {
    rawConfig = {};
  });

  test("reads a well-formed record", () => {
    rawConfig = {
      ingress: {
        assistantId: "assistant-1",
        lastTunnel: { provider: "tailscale", publicBaseUrl: TUNNEL_URL },
      },
    };

    expect(loadLastTunnelRecord()).toEqual({
      provider: "tailscale",
      publicBaseUrl: TUNNEL_URL,
    });
    expect(loadRecordedAssistantId()).toBe("assistant-1");
  });

  test("reads a pairing record beside the tunnel that owns the URL", () => {
    rawConfig = {
      ingress: {
        publicBaseUrl: "https://webhooks.ngrok.app",
        lastTunnel: {
          provider: "ngrok",
          publicBaseUrl: "https://webhooks.ngrok.app",
        },
        pairingTunnel: { provider: "tailscale", publicBaseUrl: PAIRING_URL },
      },
    };

    expect(loadPairingTunnelRecord()).toEqual({
      provider: "tailscale",
      publicBaseUrl: PAIRING_URL,
    });
    expect(loadLastTunnelRecord()).toEqual({
      provider: "ngrok",
      publicBaseUrl: "https://webhooks.ngrok.app",
    });
  });

  test("inherits the shared validation for the pairing record", () => {
    rawConfig = {
      ingress: {
        pairingTunnel: { provider: "wireguard", publicBaseUrl: PAIRING_URL },
      },
    };
    expect(loadPairingTunnelRecord()).toBeNull();

    rawConfig = { ingress: { pairingTunnel: { provider: "tailscale" } } };
    expect(loadPairingTunnelRecord()).toBeNull();
  });

  test("returns null when the ingress section is absent", () => {
    expect(loadLastTunnelRecord()).toBeNull();
    expect(loadPairingTunnelRecord()).toBeNull();
    expect(loadRecordedAssistantId()).toBeNull();
  });

  test("returns null when the ingress section is not an object", () => {
    rawConfig = { ingress: "nonsense" };

    expect(loadLastTunnelRecord()).toBeNull();
    expect(loadRecordedAssistantId()).toBeNull();
  });

  test("returns null for a provider outside the shared registry", () => {
    // Readers render the provider into a shell command they tell the user to
    // run, so an unknown one makes the whole record unusable.
    rawConfig = {
      ingress: {
        lastTunnel: { provider: "wireguard", publicBaseUrl: TUNNEL_URL },
      },
    };

    expect(loadLastTunnelRecord()).toBeNull();
  });

  test("returns null for a malformed record", () => {
    rawConfig = { ingress: { lastTunnel: { provider: "ngrok" } } };
    expect(loadLastTunnelRecord()).toBeNull();

    rawConfig = {
      ingress: {
        lastTunnel: { provider: "ngrok", publicBaseUrl: "example.ts.net" },
      },
    };
    expect(loadLastTunnelRecord()).toBeNull();
  });

  test("returns null for a blank recorded assistant id", () => {
    rawConfig = { ingress: { assistantId: "   " } };

    expect(loadRecordedAssistantId()).toBeNull();
  });

  test("falls back to typed defaults for a mistyped ingress section", () => {
    rawConfig = { ingress: { publicBaseUrl: 42, enabled: "yes" } };

    const config = getIngressConfigResult();

    expect(config.publicBaseUrl).toBe("");
    expect(config.enabled).toBe(false);
    expect(config.explicitlyDisabled).toBe(false);
  });

  test("reports Velay ownership of the public base URL", () => {
    rawConfig = {
      ingress: { publicBaseUrl: TUNNEL_URL, publicBaseUrlManagedBy: "velay" },
    };
    expect(isVelayManagedIngress()).toBe(true);

    rawConfig = { ingress: { publicBaseUrl: TUNNEL_URL } };
    expect(isVelayManagedIngress()).toBe(false);
  });
});

describe("explicitlyDisabled", () => {
  beforeEach(() => {
    rawConfig = {};
  });

  test("only an explicit false is an opt-out", () => {
    // `ingress.enabled` is opt-out across the assistant: a URL set through
    // `config set ingress.publicBaseUrl` never writes the flag and is live.
    rawConfig = { ingress: { publicBaseUrl: TUNNEL_URL } };
    expect(getIngressConfigResult().explicitlyDisabled).toBe(false);

    rawConfig = { ingress: { publicBaseUrl: TUNNEL_URL, enabled: true } };
    expect(getIngressConfigResult().explicitlyDisabled).toBe(false);

    rawConfig = { ingress: { publicBaseUrl: TUNNEL_URL, enabled: false } };
    expect(getIngressConfigResult().explicitlyDisabled).toBe(true);
  });
});

describe("dropTunnelRecordsForNewUrl", () => {
  const records = () => ({
    publicBaseUrl: TUNNEL_URL,
    assistantId: "assistant-1",
    lastTunnel: { provider: "tailscale", publicBaseUrl: TUNNEL_URL },
    pairingTunnel: { provider: "tailscale", publicBaseUrl: PAIRING_URL },
  });

  test("keeps the records when the URL is unchanged", () => {
    const ingress: Record<string, unknown> = records();

    dropTunnelRecordsForNewUrl(ingress, ` ${TUNNEL_URL}/ `);

    expect(ingress).toEqual(records());
  });

  test("drops the pairing record too, so a new URL is the one reported", () => {
    // The pairing record outranks `publicBaseUrl` in the status route, so a
    // leftover one would hide the address the user just set.
    const retargeted: Record<string, unknown> = records();

    dropTunnelRecordsForNewUrl(retargeted, "https://other.example.ts.net");

    expect(retargeted.pairingTunnel).toBeUndefined();
  });

  test("drops the records when the URL is retargeted or cleared", () => {
    const retargeted: Record<string, unknown> = records();
    dropTunnelRecordsForNewUrl(retargeted, "https://other.example.ts.net");
    expect(retargeted).toEqual({ publicBaseUrl: TUNNEL_URL });

    const cleared: Record<string, unknown> = records();
    dropTunnelRecordsForNewUrl(cleared, undefined);
    expect(cleared).toEqual({ publicBaseUrl: TUNNEL_URL });
  });

  test("is a no-op without an ingress section", () => {
    expect(() =>
      dropTunnelRecordsForNewUrl(undefined, TUNNEL_URL),
    ).not.toThrow();
  });
});

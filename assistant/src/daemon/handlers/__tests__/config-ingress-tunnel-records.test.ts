/**
 * Unit tests for the ingress section of the workspace config, including the
 * records `vellum tunnel` leaves behind. A hand-edited or half-written entry
 * must yield a typed fallback or null, never a throw or an unusable address.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

let rawConfig: Record<string, unknown> = {};

mock.module("../../../config/loader.js", () => ({
  loadRawConfig: () => rawConfig,
}));

import {
  getIngressConfigResult,
  loadLastTunnelRecord,
  loadRecordedAssistantId,
} from "../config-ingress.js";

const TUNNEL_URL = "https://assistant-1.example.ts.net";

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

  test("returns null when the ingress section is absent", () => {
    expect(loadLastTunnelRecord()).toBeNull();
    expect(loadRecordedAssistantId()).toBeNull();
  });

  test("returns null when the ingress section is not an object", () => {
    rawConfig = { ingress: "nonsense" };

    expect(loadLastTunnelRecord()).toBeNull();
    expect(loadRecordedAssistantId()).toBeNull();
  });

  test("returns null for a record missing either field", () => {
    rawConfig = { ingress: { lastTunnel: { provider: "ngrok" } } };
    expect(loadLastTunnelRecord()).toBeNull();

    rawConfig = { ingress: { lastTunnel: { publicBaseUrl: TUNNEL_URL } } };
    expect(loadLastTunnelRecord()).toBeNull();
  });

  test("returns null for a URL that is not absolute HTTP(S)", () => {
    for (const publicBaseUrl of ["", "   ", "example.ts.net", "ftp://x.test"]) {
      rawConfig = {
        ingress: { lastTunnel: { provider: "ngrok", publicBaseUrl } },
      };
      expect(loadLastTunnelRecord()).toBeNull();
    }
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
  });
});

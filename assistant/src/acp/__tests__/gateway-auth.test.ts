/**
 * Tests for the ACP gateway-mode auth resolver.
 *
 * `resolveAcpGatewayAuth()` is active only when BOTH the
 * `acp-managed-proxy-routing` feature flag is on AND managed-proxy prereqs are
 * met; otherwise it returns undefined so callers fall back to the credential
 * path. The managed-proxy context is mocked so the two gate inputs can be
 * driven independently; the flag is driven via the feature-flag override cache.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { setOverridesForTesting } from "../../__tests__/feature-flag-test-helpers.js";
import { clearFeatureFlagOverridesCache } from "../../config/assistant-feature-flags.js";

// Controllable managed-proxy context (stands in for platform base URL +
// assistant API key resolution, covered on its own elsewhere).
let ctxEnabled = false;
let ctxApiKey = "";
let managedBaseUrl: string | undefined;

mock.module("../../providers/platform-proxy/context.js", () => ({
  resolveManagedProxyContext: async () => ({
    enabled: ctxEnabled,
    platformBaseUrl: ctxEnabled ? "https://platform.example.com" : "",
    assistantApiKey: ctxApiKey,
  }),
  buildManagedBaseUrl: async () => managedBaseUrl,
}));

const {
  resolveAcpGatewayAuth,
  isAcpManagedProxyRoutingEnabled,
  ACP_MANAGED_PROXY_ROUTING_FLAG,
} = await import("../gateway-auth.js");

function enableFlag(): void {
  setOverridesForTesting({ [ACP_MANAGED_PROXY_ROUTING_FLAG]: true });
}

beforeEach(() => {
  clearFeatureFlagOverridesCache();
  ctxEnabled = false;
  ctxApiKey = "";
  managedBaseUrl = undefined;
});

afterEach(() => {
  clearFeatureFlagOverridesCache();
});

describe("resolveAcpGatewayAuth", () => {
  test("flag key matches the registry entry", () => {
    expect(ACP_MANAGED_PROXY_ROUTING_FLAG).toBe("acp-managed-proxy-routing");
  });

  test("returns undefined when the flag is OFF (default) even with proxy prereqs met", async () => {
    ctxEnabled = true;
    ctxApiKey = "sk-assistant-123";
    managedBaseUrl = "https://platform.example.com/v1/runtime-proxy/anthropic";

    expect(isAcpManagedProxyRoutingEnabled()).toBe(false);
    expect(await resolveAcpGatewayAuth()).toBeUndefined();
  });

  test("returns the gateway config when flag ON and managed proxy enabled", async () => {
    enableFlag();
    ctxEnabled = true;
    ctxApiKey = "sk-assistant-123";
    managedBaseUrl = "https://platform.example.com/v1/runtime-proxy/anthropic";

    expect(isAcpManagedProxyRoutingEnabled()).toBe(true);
    expect(await resolveAcpGatewayAuth()).toEqual({
      baseUrl: "https://platform.example.com/v1/runtime-proxy/anthropic",
      headers: {
        "x-api-key": "sk-assistant-123",
        "X-Vellum-LLM-Call-Site": "acp-child",
      },
    });
  });

  test("returns undefined when flag ON but managed proxy prereqs are unmet", async () => {
    enableFlag();
    ctxEnabled = false; // no platform URL / assistant API key

    expect(await resolveAcpGatewayAuth()).toBeUndefined();
  });

  test("returns undefined when flag ON and ctx enabled but no managed base URL (skew guard)", async () => {
    enableFlag();
    ctxEnabled = true;
    ctxApiKey = "sk-assistant-123";
    managedBaseUrl = undefined;

    expect(await resolveAcpGatewayAuth()).toBeUndefined();
  });
});

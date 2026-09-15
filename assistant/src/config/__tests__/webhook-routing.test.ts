/**
 * Unit tests for `hasWebhookRoutingConfigured`'s resolution order (LUM-2882).
 *
 * The predicate has to agree with `handleWebhooksRegister` in
 * `runtime/routes/webhook-routes.ts` tier for tier. Where they disagree, the
 * status surfaces (channel readiness, the Telegram webhook health sweep) report
 * a state the registration path contradicts, which hides a broken registration
 * instead of surfacing it. The tier cases here mirror the ones in
 * `runtime/routes/__tests__/webhook-routes.test.ts`.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

let isPlatform = false;
let velayWebhooksEnabled = false;
let rawConfig: Record<string, unknown> = {};
let platformContextEnabled = false;

// Spread the real modules: these are broad barrels and replacing them wholesale
// breaks unrelated importers pulled in by the module under test.
const actualEnvRegistry = await import("../env-registry.js");
mock.module("../env-registry.js", () => ({
  ...actualEnvRegistry,
  getIsPlatform: () => isPlatform,
}));

const actualLoader = await import("../loader.js");
mock.module("../loader.js", () => ({
  ...actualLoader,
  loadRawConfig: () => rawConfig,
  getConfig: () => rawConfig,
}));

const actualVelayGate = await import("../../inbound/velay-webhooks-gate.js");
mock.module("../../inbound/velay-webhooks-gate.js", () => ({
  ...actualVelayGate,
  isVelayWebhooksEnabled: () => velayWebhooksEnabled,
}));

const actualRegistration =
  await import("../../inbound/platform-callback-registration.js");
mock.module("../../inbound/platform-callback-registration.js", () => ({
  ...actualRegistration,
  resolvePlatformCallbackRegistrationContext: async () => ({
    isPlatform,
    platformBaseUrl: "https://api.vellum.ai",
    assistantId: platformContextEnabled ? "assistant-123" : "",
    hasAssistantApiKey: platformContextEnabled,
    authHeader: platformContextEnabled ? "Api-Key secret" : null,
    enabled: platformContextEnabled,
  }),
}));

const { hasIngressConfigured, hasWebhookRoutingConfigured } =
  await import("../webhook-routing.js");

describe("hasWebhookRoutingConfigured resolution order", () => {
  beforeEach(() => {
    isPlatform = false;
    velayWebhooksEnabled = false;
    rawConfig = {};
    platformContextEnabled = false;
  });

  // ── Tier 1: platform pods ────────────────────────────────────────────────

  test("platform pods use managed callbacks", async () => {
    isPlatform = true;

    expect(await hasWebhookRoutingConfigured(true)).toEqual({
      configured: true,
      usesManagedCallbacks: true,
    });
  });

  test("platform pods report managed even with an ingress URL configured", async () => {
    isPlatform = true;
    rawConfig = { ingress: { publicBaseUrl: "https://tunnel.example.com" } };

    // `handleWebhooksRegister` registers with the platform gateway before it
    // ever reads the ingress config on a pod, so reporting the ingress URL
    // here would name a URL no webhook is actually registered against.
    expect(await hasWebhookRoutingConfigured(true)).toEqual({
      configured: true,
      usesManagedCallbacks: true,
    });
  });

  test("velay-webhooks on: a pod with a published ingress URL reports it", async () => {
    isPlatform = true;
    velayWebhooksEnabled = true;
    rawConfig = { ingress: { publicBaseUrl: "https://tunnel.example.com" } };

    expect(await hasWebhookRoutingConfigured(true)).toEqual({
      configured: true,
      usesManagedCallbacks: false,
    });
  });

  test("velay-webhooks on: a pod with no published URL still reports managed", async () => {
    isPlatform = true;
    velayWebhooksEnabled = true;

    expect(await hasWebhookRoutingConfigured(true)).toEqual({
      configured: true,
      usesManagedCallbacks: true,
    });
  });

  test("velay-webhooks on: a pod with ingress disabled falls back to managed", async () => {
    isPlatform = true;
    velayWebhooksEnabled = true;
    rawConfig = { ingress: { enabled: false } };

    // Matches `resolveCallbackUrl` on pods: an owner toggling ingress off
    // must not lose webhooks entirely.
    expect(await hasWebhookRoutingConfigured(true)).toEqual({
      configured: true,
      usesManagedCallbacks: true,
    });
  });

  // ── Tier 2: a configured ingress wins ────────────────────────────────────

  test("ingress beats the platform-connected fallback", async () => {
    platformContextEnabled = true;
    rawConfig = { ingress: { publicBaseUrl: "https://tunnel.example.com" } };

    // Any logged-in local assistant holds platform credentials for the LLM
    // proxy, so credential presence must not reroute an explicitly configured
    // self-hosted webhook through the platform.
    expect(await hasWebhookRoutingConfigured(true)).toEqual({
      configured: true,
      usesManagedCallbacks: false,
    });
  });

  test("the twilio option resolves ingress before the fallback too", async () => {
    platformContextEnabled = true;
    rawConfig = { ingress: { publicBaseUrl: "https://twilio.example.com" } };

    expect(await hasWebhookRoutingConfigured(true, { twilio: true })).toEqual({
      configured: true,
      usesManagedCallbacks: false,
    });
  });

  test.each([undefined, { publicBaseUrl: "" }, { enabled: false }])(
    "platform credentials do not make missing ingress ready: %j",
    async (ingress) => {
      platformContextEnabled = true;
      rawConfig = { ingress };
      for (const twilio of [true, false]) {
        expect(await hasWebhookRoutingConfigured(true, { twilio })).toEqual({
          configured: false,
          usesManagedCallbacks: false,
        });
      }
    },
  );

  test("an explicit ingress.enabled false blocks the fallback", async () => {
    platformContextEnabled = true;
    rawConfig = { ingress: { enabled: false } };

    // Opting out is a decision not to accept inbound webhooks at all, not an
    // invitation to route them through the platform instead.
    expect(await hasWebhookRoutingConfigured(true)).toEqual({
      configured: false,
      usesManagedCallbacks: false,
    });
  });

  test("ingress.enabled false blocks the fallback even with a URL configured", async () => {
    platformContextEnabled = true;
    rawConfig = {
      ingress: { enabled: false, publicBaseUrl: "https://tunnel.example.com" },
    };

    expect(await hasWebhookRoutingConfigured(true)).toEqual({
      configured: false,
      usesManagedCallbacks: false,
    });
  });

  // ── Tier 4: nothing configured ───────────────────────────────────────────

  test("no ingress and no platform connectivity is not configured", async () => {
    expect(await hasWebhookRoutingConfigured(true)).toEqual({
      configured: false,
      usesManagedCallbacks: false,
    });
  });

  // ── allowManagedCallbacks gating ─────────────────────────────────────────

  test("allowManagedCallbacks false hides the platform-connected fallback", async () => {
    platformContextEnabled = true;

    // Channels that can only be served by a self-hosted ingress pass `false`
    // and must never be told a managed route stands in for one.
    expect(await hasWebhookRoutingConfigured(false)).toEqual({
      configured: false,
      usesManagedCallbacks: false,
    });
  });

  test("allowManagedCallbacks false hides the platform-pod tier", async () => {
    isPlatform = true;

    expect(await hasWebhookRoutingConfigured(false)).toEqual({
      configured: false,
      usesManagedCallbacks: false,
    });
  });

  test("allowManagedCallbacks false still honors a configured ingress", async () => {
    rawConfig = { ingress: { publicBaseUrl: "https://tunnel.example.com" } };

    expect(await hasWebhookRoutingConfigured(false)).toEqual({
      configured: true,
      usesManagedCallbacks: false,
    });
  });
});

describe("hasIngressConfigured", () => {
  beforeEach(() => {
    isPlatform = false;
    rawConfig = {};
    platformContextEnabled = false;
  });

  test("is unaffected by platform connectivity", () => {
    platformContextEnabled = true;

    expect(hasIngressConfigured()).toBe(false);
  });

  test("treats an unset enabled flag with a URL as enabled", () => {
    rawConfig = { ingress: { publicBaseUrl: "https://tunnel.example.com" } };

    expect(hasIngressConfigured()).toBe(true);
  });

  test("treats an explicit enabled false as not configured", () => {
    rawConfig = {
      ingress: { enabled: false, publicBaseUrl: "https://tunnel.example.com" },
    };

    expect(hasIngressConfigured()).toBe(false);
  });
});

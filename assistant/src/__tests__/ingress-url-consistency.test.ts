import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — silence logger output during tests
// ---------------------------------------------------------------------------

function makeLoggerStub(): Record<string, unknown> {
  const stub: Record<string, unknown> = {};
  for (const m of [
    "info",
    "warn",
    "error",
    "debug",
    "trace",
    "fatal",
    "silent",
    "child",
  ]) {
    stub[m] = m === "child" ? () => makeLoggerStub() : () => {};
  }
  return stub;
}

mock.module("../util/logger.js", () => ({
  getLogger: () => makeLoggerStub(),
}));

import { setIngressPublicBaseUrl } from "../config/env.js";
import {
  getPublicBaseUrl,
  getTwilioStatusCallbackUrl,
  getTwilioVoiceWebhookUrl,
  type IngressConfig,
} from "../inbound/public-ingress-urls.js";

// ---------------------------------------------------------------------------
// Helpers — simulate Twilio signature validation the same way the gateway does
// ---------------------------------------------------------------------------

/**
 * Reproduce the gateway's canonical URL reconstruction logic from
 * gateway/src/twilio/validate-webhook.ts (lines 72-76).
 */
function reconstructGatewayCanonicalUrl(
  ingressPublicBaseUrl: string | undefined,
  requestUrl: string,
): string {
  const parsedUrl = new URL(requestUrl);
  if (ingressPublicBaseUrl) {
    return (
      ingressPublicBaseUrl.replace(/\/$/, "") +
      parsedUrl.pathname +
      parsedUrl.search
    );
  }
  return requestUrl;
}

/**
 * Reproduce Twilio's HMAC-SHA1 signature algorithm (same as
 * gateway/src/twilio/verify.ts).
 */
function computeTwilioSignature(
  url: string,
  params: Record<string, string>,
  authToken: string,
): string {
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) {
    data += key + params[key];
  }
  return createHmac("sha1", authToken).update(data).digest("base64");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Ingress URL consistency between assistant and gateway", () => {
  beforeEach(() => {
    setIngressPublicBaseUrl(undefined);
  });

  afterEach(() => {
    setIngressPublicBaseUrl(undefined);
  });

  test("assistant callback URL and gateway signature reconstruction use same base when config is set", () => {
    const config: IngressConfig = {
      ingress: { publicBaseUrl: "https://my-tunnel.ngrok.io" },
    };

    // What the assistant would generate as the Twilio voice webhook callback
    const assistantCallbackUrl = getTwilioVoiceWebhookUrl(
      config,
      "session-abc",
    );

    // The gateway reads config.ingress.publicBaseUrl from the workspace config
    // file via ConfigFileCache.
    const gatewayIngressPublicBaseUrl = getPublicBaseUrl(config);

    // When Twilio calls the gateway, the gateway reconstructs the canonical URL
    // from the inbound request URL (which is localhost) + the configured base.
    const inboundRequestUrl =
      "http://127.0.0.1:7830/webhooks/twilio/voice?callSessionId=session-abc";
    const gatewayCanonicalUrl = reconstructGatewayCanonicalUrl(
      gatewayIngressPublicBaseUrl,
      inboundRequestUrl,
    );

    // Both must resolve to the same URL for Twilio signatures to validate
    expect(gatewayCanonicalUrl).toBe(assistantCallbackUrl);
  });

  test("Twilio signature computed against assistant URL validates at gateway", () => {
    const publicBase = "https://my-tunnel.ngrok.io";
    const authToken = "test-twilio-auth-token-12345";
    const config: IngressConfig = {
      ingress: { publicBaseUrl: publicBase },
    };

    // Assistant generates the callback URL and registers it with Twilio
    const callbackUrl = getTwilioStatusCallbackUrl(config);
    expect(callbackUrl).toBe(
      "https://my-tunnel.ngrok.io/webhooks/twilio/status",
    );

    // Twilio signs the request using the callback URL
    const params = { CallSid: "CA123", CallStatus: "completed" };
    const twilioSignature = computeTwilioSignature(
      callbackUrl,
      params,
      authToken,
    );

    // Gateway receives the request on its local address
    const localRequestUrl = "http://127.0.0.1:7830/webhooks/twilio/status";

    // Gateway reconstructs the canonical URL using its configured base
    // (which was read from the workspace config file via ConfigFileCache)
    const gatewayIngressPublicBaseUrl = getPublicBaseUrl(config);
    const canonicalUrl = reconstructGatewayCanonicalUrl(
      gatewayIngressPublicBaseUrl,
      localRequestUrl,
    );

    // Verify the signature matches
    const recomputedSignature = computeTwilioSignature(
      canonicalUrl,
      params,
      authToken,
    );
    expect(recomputedSignature).toBe(twilioSignature);
  });

  test("mismatch scenario: gateway without config creates signature validation failure", () => {
    const authToken = "test-twilio-auth-token-12345";

    // Assistant uses config-based URL
    const assistantConfig: IngressConfig = {
      ingress: { publicBaseUrl: "https://my-tunnel.ngrok.io" },
    };
    const callbackUrl = getTwilioStatusCallbackUrl(assistantConfig);

    // Twilio signs against the callback URL the assistant registered
    const params = { CallSid: "CA123", CallStatus: "completed" };
    const twilioSignature = computeTwilioSignature(
      callbackUrl,
      params,
      authToken,
    );

    // Gateway does NOT have the ingress URL configured (simulating the bug)
    const localRequestUrl = "http://127.0.0.1:7830/webhooks/twilio/status";
    const canonicalUrlWithout = reconstructGatewayCanonicalUrl(
      undefined,
      localRequestUrl,
    );

    // Signature should NOT match — this proves the mismatch bug
    const recomputedWithout = computeTwilioSignature(
      canonicalUrlWithout,
      params,
      authToken,
    );
    expect(recomputedWithout).not.toBe(twilioSignature);

    // Now simulate the fix: gateway has the same ingress URL
    const canonicalUrlWith = reconstructGatewayCanonicalUrl(
      "https://my-tunnel.ngrok.io",
      localRequestUrl,
    );
    const recomputedWith = computeTwilioSignature(
      canonicalUrlWith,
      params,
      authToken,
    );
    expect(recomputedWith).toBe(twilioSignature);
  });

  test("module-level state fallback produces consistent URLs across assistant and gateway", () => {
    // When no config.ingress.publicBaseUrl is set, the assistant falls back
    // to the module-level ingress state.
    setIngressPublicBaseUrl("https://env-tunnel.example.com");

    const config: IngressConfig = {};

    // Assistant resolves the base URL from module state
    const assistantBase = getPublicBaseUrl(config);
    expect(assistantBase).toBe("https://env-tunnel.example.com");

    // Gateway would read the same value from the workspace config file
    // via ConfigFileCache.getString("ingress", "publicBaseUrl").
    const gatewayIngressPublicBaseUrl = "https://env-tunnel.example.com";

    // Callback URL generated by assistant
    const callbackUrl = getTwilioVoiceWebhookUrl(config, "session-xyz");

    // Gateway canonical URL reconstruction
    const localUrl =
      "http://127.0.0.1:7830/webhooks/twilio/voice?callSessionId=session-xyz";
    const gatewayCanonical = reconstructGatewayCanonicalUrl(
      gatewayIngressPublicBaseUrl,
      localUrl,
    );

    expect(gatewayCanonical).toBe(callbackUrl);
  });

  test("trailing slashes are normalized consistently", () => {
    const config: IngressConfig = {
      ingress: { publicBaseUrl: "https://my-tunnel.ngrok.io///" },
    };

    const assistantBase = getPublicBaseUrl(config);
    expect(assistantBase).toBe("https://my-tunnel.ngrok.io");

    const callbackUrl = getTwilioVoiceWebhookUrl(config, "session-1");

    // Gateway would receive the normalized value (hatch.ts trims trailing slashes)
    const gatewayBase = "https://my-tunnel.ngrok.io";
    const localUrl =
      "http://127.0.0.1:7830/webhooks/twilio/voice?callSessionId=session-1";
    const gatewayCanonical = reconstructGatewayCanonicalUrl(
      gatewayBase,
      localUrl,
    );

    expect(gatewayCanonical).toBe(callbackUrl);
  });

  test("all Twilio webhook paths share the /webhooks/twilio/ prefix consistently", () => {
    const config: IngressConfig = {
      ingress: { publicBaseUrl: "https://consistent.example.com" },
    };
    const base = getPublicBaseUrl(config);

    // Document the path contract: all Twilio webhooks live under /webhooks/twilio/
    const voiceUrl = getTwilioVoiceWebhookUrl(config, "sess");
    const statusUrl = getTwilioStatusCallbackUrl(config);

    // Verify they all share the same base and prefix
    expect(voiceUrl).toStartWith(`${base}/webhooks/twilio/`);
    expect(statusUrl).toStartWith(`${base}/webhooks/twilio/`);
  });
});

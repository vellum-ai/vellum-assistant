import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { createHmac } from 'node:crypto';

// ---------------------------------------------------------------------------
// Mocks — silence logger output during tests
// ---------------------------------------------------------------------------

function makeLoggerStub(): Record<string, unknown> {
  const stub: Record<string, unknown> = {};
  for (const m of ['info', 'warn', 'error', 'debug', 'trace', 'fatal', 'silent', 'child']) {
    stub[m] = m === 'child' ? () => makeLoggerStub() : () => {};
  }
  return stub;
}

mock.module('../util/logger.js', () => ({
  getLogger: () => makeLoggerStub(),
}));

import {
  getPublicBaseUrl,
  getTwilioVoiceWebhookUrl,
  getTwilioStatusCallbackUrl,
  type IngressConfig,
} from '../inbound/public-ingress-urls.js';

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
    return ingressPublicBaseUrl.replace(/\/$/, '') + parsedUrl.pathname + parsedUrl.search;
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
  return createHmac('sha1', authToken).update(data).digest('base64');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Ingress URL consistency between assistant and gateway', () => {
  let savedIngressEnv: string | undefined;

  beforeEach(() => {
    savedIngressEnv = process.env.INGRESS_PUBLIC_BASE_URL;
    delete process.env.INGRESS_PUBLIC_BASE_URL;
  });

  afterEach(() => {
    if (savedIngressEnv !== undefined) {
      process.env.INGRESS_PUBLIC_BASE_URL = savedIngressEnv;
    } else {
      delete process.env.INGRESS_PUBLIC_BASE_URL;
    }
  });

  test('assistant callback URL and gateway signature reconstruction use same base when config is set', () => {
    const config: IngressConfig = {
      ingress: { publicBaseUrl: 'https://my-tunnel.ngrok.io' },
    };

    // What the assistant would generate as the Twilio voice webhook callback
    const assistantCallbackUrl = getTwilioVoiceWebhookUrl(config, 'session-abc');

    // Simulate: when hatch.ts spawns the gateway, it reads config.ingress.publicBaseUrl
    // and passes it as INGRESS_PUBLIC_BASE_URL. The gateway stores this as
    // config.ingressPublicBaseUrl.
    const gatewayIngressPublicBaseUrl = getPublicBaseUrl(config);

    // When Twilio calls the gateway, the gateway reconstructs the canonical URL
    // from the inbound request URL (which is localhost) + the configured base.
    const inboundRequestUrl = 'http://127.0.0.1:7830/webhooks/twilio/voice?callSessionId=session-abc';
    const gatewayCanonicalUrl = reconstructGatewayCanonicalUrl(
      gatewayIngressPublicBaseUrl,
      inboundRequestUrl,
    );

    // Both must resolve to the same URL for Twilio signatures to validate
    expect(gatewayCanonicalUrl).toBe(assistantCallbackUrl);
  });

  test('Twilio signature computed against assistant URL validates at gateway', () => {
    const publicBase = 'https://my-tunnel.ngrok.io';
    const authToken = 'test-twilio-auth-token-12345';
    const config: IngressConfig = {
      ingress: { publicBaseUrl: publicBase },
    };

    // Assistant generates the callback URL and registers it with Twilio
    const callbackUrl = getTwilioStatusCallbackUrl(config);
    expect(callbackUrl).toBe('https://my-tunnel.ngrok.io/webhooks/twilio/status');

    // Twilio signs the request using the callback URL
    const params = { CallSid: 'CA123', CallStatus: 'completed' };
    const twilioSignature = computeTwilioSignature(callbackUrl, params, authToken);

    // Gateway receives the request on its local address
    const localRequestUrl = 'http://127.0.0.1:7830/webhooks/twilio/status';

    // Gateway reconstructs the canonical URL using its configured base
    // (which was passed from the assistant's config via INGRESS_PUBLIC_BASE_URL)
    const gatewayIngressPublicBaseUrl = getPublicBaseUrl(config);
    const canonicalUrl = reconstructGatewayCanonicalUrl(
      gatewayIngressPublicBaseUrl,
      localRequestUrl,
    );

    // Verify the signature matches
    const recomputedSignature = computeTwilioSignature(canonicalUrl, params, authToken);
    expect(recomputedSignature).toBe(twilioSignature);
  });

  test('mismatch scenario: gateway without config creates signature validation failure', () => {
    const authToken = 'test-twilio-auth-token-12345';

    // Assistant uses config-based URL
    const assistantConfig: IngressConfig = {
      ingress: { publicBaseUrl: 'https://my-tunnel.ngrok.io' },
    };
    const callbackUrl = getTwilioStatusCallbackUrl(assistantConfig);

    // Twilio signs against the callback URL the assistant registered
    const params = { CallSid: 'CA123', CallStatus: 'completed' };
    const twilioSignature = computeTwilioSignature(callbackUrl, params, authToken);

    // Gateway does NOT have the ingress URL configured (simulating the bug)
    const localRequestUrl = 'http://127.0.0.1:7830/webhooks/twilio/status';
    const canonicalUrlWithout = reconstructGatewayCanonicalUrl(undefined, localRequestUrl);

    // Signature should NOT match — this proves the mismatch bug
    const recomputedWithout = computeTwilioSignature(canonicalUrlWithout, params, authToken);
    expect(recomputedWithout).not.toBe(twilioSignature);

    // Now simulate the fix: gateway has the same ingress URL
    const canonicalUrlWith = reconstructGatewayCanonicalUrl(
      'https://my-tunnel.ngrok.io',
      localRequestUrl,
    );
    const recomputedWith = computeTwilioSignature(canonicalUrlWith, params, authToken);
    expect(recomputedWith).toBe(twilioSignature);
  });

  test('env var fallback produces consistent URLs across assistant and gateway', () => {
    // When no config.ingress.publicBaseUrl is set, both assistant and gateway
    // fall back to the INGRESS_PUBLIC_BASE_URL env var.
    process.env.INGRESS_PUBLIC_BASE_URL = 'https://env-tunnel.example.com';

    const config: IngressConfig = {};

    // Assistant resolves the base URL from env
    const assistantBase = getPublicBaseUrl(config);
    expect(assistantBase).toBe('https://env-tunnel.example.com');

    // Gateway would also read the same env var (process.env.INGRESS_PUBLIC_BASE_URL)
    // and store it as config.ingressPublicBaseUrl.
    const gatewayIngressPublicBaseUrl = process.env.INGRESS_PUBLIC_BASE_URL;

    // Callback URL generated by assistant
    const callbackUrl = getTwilioVoiceWebhookUrl(config, 'session-xyz');

    // Gateway canonical URL reconstruction
    const localUrl = 'http://127.0.0.1:7830/webhooks/twilio/voice?callSessionId=session-xyz';
    const gatewayCanonical = reconstructGatewayCanonicalUrl(
      gatewayIngressPublicBaseUrl,
      localUrl,
    );

    expect(gatewayCanonical).toBe(callbackUrl);
  });

  test('trailing slashes are normalized consistently', () => {
    const config: IngressConfig = {
      ingress: { publicBaseUrl: 'https://my-tunnel.ngrok.io///' },
    };

    const assistantBase = getPublicBaseUrl(config);
    expect(assistantBase).toBe('https://my-tunnel.ngrok.io');

    const callbackUrl = getTwilioVoiceWebhookUrl(config, 'session-1');

    // Gateway would receive the normalized value (hatch.ts trims trailing slashes)
    const gatewayBase = 'https://my-tunnel.ngrok.io';
    const localUrl = 'http://127.0.0.1:7830/webhooks/twilio/voice?callSessionId=session-1';
    const gatewayCanonical = reconstructGatewayCanonicalUrl(gatewayBase, localUrl);

    expect(gatewayCanonical).toBe(callbackUrl);
  });
});

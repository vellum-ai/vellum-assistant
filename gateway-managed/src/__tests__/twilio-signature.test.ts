import { describe, expect, test } from "bun:test";

import { loadConfig } from "../config.js";
import {
  computeTwilioSignature,
  validateManagedTwilioSignature,
} from "../twilio-signature.js";

const FAR_FUTURE = "2099-01-01T00:00:00.000Z";
const FAR_PAST = "2000-01-01T00:00:00.000Z";

type EnvOverrides = Record<string, string | undefined>;

function makeConfig(overrides: EnvOverrides = {}): ReturnType<typeof loadConfig> {
  return loadConfig({
    ...process.env,
    MANAGED_GATEWAY_ENABLED: "true",
    MANAGED_GATEWAY_STRICT_STARTUP_VALIDATION: "true",
    MANAGED_GATEWAY_DJANGO_INTERNAL_BASE_URL: "http://127.0.0.1:8000",
    MANAGED_GATEWAY_INTERNAL_AUTH_MODE: "bearer",
    MANAGED_GATEWAY_INTERNAL_AUTH_AUDIENCE: "managed-gateway-internal",
    MANAGED_GATEWAY_INTERNAL_BEARER_TOKENS: JSON.stringify({
      "token-active": {
        token_id: "mgw-2026-01",
        principal: "managed-gateway-staging",
        audience: "managed-gateway-internal",
        scopes: ["managed-gateway:internal", "routes:resolve"],
        expires_at: FAR_FUTURE,
      },
    }),
    MANAGED_GATEWAY_TWILIO_AUTH_TOKENS: JSON.stringify({
      "twilio-current": {
        token_id: "twilio-2026-01",
        auth_token: "twilio-current-secret",
        expires_at: FAR_FUTURE,
      },
    }),
    MANAGED_GATEWAY_TWILIO_REVOKED_TOKEN_IDS: "",
    ...overrides,
  });
}

describe("managed-gateway Twilio signature verifier", () => {
  test("rejects missing signature", () => {
    const result = validateManagedTwilioSignature(makeConfig(), {
      url: "https://managed-gateway.example/webhooks/twilio/sms",
      params: { From: "+15550000000", To: "+15559999999", Body: "hello" },
      signature: "",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("missing_signature");
    }
  });

  test("rejects invalid signature", () => {
    const result = validateManagedTwilioSignature(makeConfig(), {
      url: "https://managed-gateway.example/webhooks/twilio/sms",
      params: { From: "+15550000000", To: "+15559999999", Body: "hello" },
      signature: "invalid-signature",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("invalid_signature");
    }
  });

  test("accepts valid signature from active token", () => {
    const url = "https://managed-gateway.example/webhooks/twilio/sms";
    const params = { From: "+15550000000", To: "+15559999999", Body: "hello" };
    const signature = computeTwilioSignature(url, params, "twilio-current-secret");

    const result = validateManagedTwilioSignature(makeConfig(), {
      url,
      params,
      signature,
    });

    expect(result).toEqual({
      ok: true,
      tokenId: "twilio-2026-01",
    });
  });

  test("accepts rotated token overlap during rollout", () => {
    const url = "https://managed-gateway.example/webhooks/twilio/sms";
    const params = { From: "+15550000001", To: "+15559999999", Body: "rotation-check" };
    const config = makeConfig({
      MANAGED_GATEWAY_TWILIO_AUTH_TOKENS: JSON.stringify({
        "twilio-old": {
          token_id: "twilio-2026-01",
          auth_token: "twilio-old-secret",
          expires_at: FAR_FUTURE,
        },
        "twilio-new": {
          token_id: "twilio-2026-02",
          auth_token: "twilio-new-secret",
          expires_at: FAR_FUTURE,
        },
      }),
    });

    const oldSignature = computeTwilioSignature(url, params, "twilio-old-secret");
    const newSignature = computeTwilioSignature(url, params, "twilio-new-secret");

    expect(validateManagedTwilioSignature(config, {
      url,
      params,
      signature: oldSignature,
    })).toEqual({
      ok: true,
      tokenId: "twilio-2026-01",
    });
    expect(validateManagedTwilioSignature(config, {
      url,
      params,
      signature: newSignature,
    })).toEqual({
      ok: true,
      tokenId: "twilio-2026-02",
    });
  });

  test("rejects revoked old token and accepts new token after rotation", () => {
    const url = "https://managed-gateway.example/webhooks/twilio/sms";
    const params = { From: "+15550000002", To: "+15559999999", Body: "revoke-check" };
    const config = makeConfig({
      MANAGED_GATEWAY_TWILIO_AUTH_TOKENS: JSON.stringify({
        "twilio-old": {
          token_id: "twilio-2026-01",
          auth_token: "twilio-old-secret",
          expires_at: FAR_FUTURE,
        },
        "twilio-new": {
          token_id: "twilio-2026-02",
          auth_token: "twilio-new-secret",
          expires_at: FAR_FUTURE,
        },
      }),
      MANAGED_GATEWAY_TWILIO_REVOKED_TOKEN_IDS: "twilio-2026-01",
    });

    const oldSignature = computeTwilioSignature(url, params, "twilio-old-secret");
    const newSignature = computeTwilioSignature(url, params, "twilio-new-secret");

    expect(validateManagedTwilioSignature(config, {
      url,
      params,
      signature: oldSignature,
    })).toEqual({
      ok: false,
      code: "invalid_signature",
      detail: "Invalid Twilio request signature.",
    });

    expect(validateManagedTwilioSignature(config, {
      url,
      params,
      signature: newSignature,
    })).toEqual({
      ok: true,
      tokenId: "twilio-2026-02",
    });
  });

  test("rejects expired token as inactive", () => {
    const url = "https://managed-gateway.example/webhooks/twilio/sms";
    const params = { From: "+15550000003", To: "+15559999999", Body: "expired-check" };
    const config = makeConfig({
      MANAGED_GATEWAY_STRICT_STARTUP_VALIDATION: "false",
      MANAGED_GATEWAY_TWILIO_AUTH_TOKENS: JSON.stringify({
        "twilio-expired": {
          token_id: "twilio-2026-01",
          auth_token: "twilio-expired-secret",
          expires_at: FAR_PAST,
        },
      }),
    });

    const signature = computeTwilioSignature(url, params, "twilio-expired-secret");

    expect(validateManagedTwilioSignature(config, {
      url,
      params,
      signature,
    })).toEqual({
      ok: false,
      code: "no_active_tokens",
      detail: "No active Twilio auth tokens are configured.",
    });
  });
});

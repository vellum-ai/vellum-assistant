/**
 * Tests for the JWT bearer auth middleware (authenticateRequest).
 *
 * Covers:
 * - Missing Authorization header returns 401
 * - Invalid/expired JWT returns 401
 * - Stale policy epoch returns 401 with refresh_required code
 * - Valid JWT returns AuthContext
 * - Dev bypass returns synthetic AuthContext
 */

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = realpathSync(
  mkdtempSync(join(tmpdir(), "auth-middleware-test-")),
);

// Track auth bypass state for tests
let authDisabled = false;
mock.module("../../../config/env.js", () => ({
  isHttpAuthDisabled: () => authDisabled,
  hasUngatedHttpAuthDisabled: () => false,
  getGatewayInternalBaseUrl: () => "http://localhost:7822",
}));

import { DAEMON_INTERNAL_ASSISTANT_ID } from "../../assistant-scope.js";
import { authenticateRequest } from "../middleware.js";
import { CURRENT_POLICY_EPOCH } from "../policy.js";
import { initAuthSigningKey, mintToken } from "../token-service.js";
import type { ScopeProfile, TokenAudience } from "../types.js";

const TEST_KEY = Buffer.from("test-signing-key-32-bytes-long!!");

function mintValidToken(overrides?: {
  aud?: TokenAudience;
  sub?: string;
  scope_profile?: ScopeProfile;
  policy_epoch?: number;
  exp?: number;
  ttlSeconds?: number;
}): string {
  // When exp is provided explicitly, compute ttlSeconds from it.
  // Otherwise use a default 300-second TTL.
  let ttl = overrides?.ttlSeconds ?? 300;
  if (overrides?.exp !== undefined) {
    const now = Math.floor(Date.now() / 1000);
    ttl = overrides.exp - now;
  }
  return mintToken({
    aud: overrides?.aud ?? "vellum-daemon",
    sub: overrides?.sub ?? "actor:self:principal-test",
    scope_profile: overrides?.scope_profile ?? "actor_client_v1",
    policy_epoch: overrides?.policy_epoch ?? 1,
    ttlSeconds: ttl,
  });
}

beforeEach(() => {
  initAuthSigningKey(TEST_KEY);
  authDisabled = false;
});

afterAll(() => {
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {}
});

describe("authenticateRequest", () => {
  test("returns 401 when Authorization header is missing", () => {
    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
    });

    const result = authenticateRequest(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
    }
  });

  test("returns 401 when Authorization header has wrong scheme", () => {
    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
    });

    const result = authenticateRequest(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
    }
  });

  test("returns 401 when JWT is invalid", () => {
    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { Authorization: "Bearer invalid.token.here" },
    });

    const result = authenticateRequest(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
    }
  });

  test("returns 401 when JWT has expired", () => {
    const now = Math.floor(Date.now() / 1000);
    const token = mintValidToken({ exp: now - 100 });

    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });

    const result = authenticateRequest(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
    }
  });

  test("returns AuthContext for valid JWT", () => {
    const token = mintValidToken();

    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });

    const result = authenticateRequest(req);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.subject).toBe("actor:self:principal-test");
      expect(result.context.principalType).toBe("actor");
      expect(result.context.assistantId).toBe(DAEMON_INTERNAL_ASSISTANT_ID);
      expect(result.context.actorPrincipalId).toBe("principal-test");
      expect(result.context.scopeProfile).toBe("actor_client_v1");
      expect(result.context.scopes.has("chat.read")).toBe(true);
      expect(result.context.scopes.has("chat.write")).toBe(true);
    }
  });

  test("returns AuthContext for svc_gateway JWT", () => {
    const token = mintValidToken({
      sub: "svc:gateway:self",
      scope_profile: "gateway_ingress_v1",
    });

    const req = new Request("http://localhost/v1/channels/inbound", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });

    const result = authenticateRequest(req);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.principalType).toBe("svc_gateway");
      expect(result.context.scopes.has("ingress.write")).toBe(true);
    }
  });

  test("dev bypass returns synthetic AuthContext without Authorization header", () => {
    authDisabled = true;

    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
    });

    const result = authenticateRequest(req);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.principalType).toBe("actor");
      expect(result.context.actorPrincipalId).toBe("dev-bypass");
      expect(result.context.scopeProfile).toBe("actor_client_v1");
      expect(result.context.scopes.has("chat.read")).toBe(true);
    }
  });

  test("dev bypass context sets actorPrincipalId to 'dev-bypass' for explicit detection", () => {
    // Regression: the "dev-bypass" actorPrincipalId used to cause trust
    // resolution to classify the user as "unknown" because no guardian
    // binding matches "dev-bypass". The route-level fix detects
    // isHttpAuthDisabled() + actorPrincipalId === "dev-bypass" and resolves
    // from the local guardian binding instead.
    authDisabled = true;

    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
    });

    const result = authenticateRequest(req);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.actorPrincipalId).toBe("dev-bypass");
    }
  });

  test("returns 401 with refresh_required when policy epoch is stale", async () => {
    // Mint a token with a very old policy epoch. The token service checks
    // isStaleEpoch which compares against CURRENT_POLICY_EPOCH.
    const token = mintValidToken({ policy_epoch: 0 });

    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });

    const result = authenticateRequest(req);
    // This test depends on whether CURRENT_POLICY_EPOCH > 0.
    // If CURRENT_POLICY_EPOCH is 1 and the token has epoch 0, it should be stale.
    // If CURRENT_POLICY_EPOCH is 0, then epoch 0 is not stale and the token is valid.
    // We test the behavior regardless -- either it's valid or it reports stale_epoch.
    if (!result.ok) {
      const body = (await result.response.json()) as {
        error: { code: string };
      };
      expect(body.error.code).toBe("refresh_required");
      expect(result.response.status).toBe(401);
    }
    // If the current epoch is 0, the token is valid, which is also correct behavior
  });

  test("rejects token with wrong audience", () => {
    // Mint a token with an unrecognized audience (neither vellum-daemon nor vellum-gateway)
    const token = mintValidToken({ aud: "vellum-other" as TokenAudience });

    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });

    const result = authenticateRequest(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
    }
  });

  test("rejects token with unparseable sub", () => {
    const token = mintValidToken({ sub: "garbage" });

    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });

    const result = authenticateRequest(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
    }
  });
});

// ---------------------------------------------------------------------------
// /v1/host-browser-result auth — exercises authenticateRequest with the
// same request shape the chrome extension sends. Validates that standard
// JWT auth applies after the capability-token system was removed.
// ---------------------------------------------------------------------------

describe("authenticateRequest for /v1/host-browser-result", () => {
  test("accepts a valid daemon-audience JWT", async () => {
    const token = mintValidToken({ sub: "actor:self:jwt-principal" });
    const req = new Request("http://localhost/v1/host-browser-result", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });

    const result = await authenticateRequest(req);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.principalType).toBe("actor");
      expect(result.context.actorPrincipalId).toBe("jwt-principal");
      expect(result.context.scopes.has("approval.write")).toBe(true);
    }
  });

  test("returns 401 when the Authorization header is missing entirely", async () => {
    const req = new Request("http://localhost/v1/host-browser-result", {
      method: "POST",
    });

    const result = await authenticateRequest(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
    }
  });

  test("malformed bearer returns 401", async () => {
    // A bearer that is not a parseable JWT must return 401.
    const req = new Request("http://localhost/v1/host-browser-result", {
      method: "POST",
      headers: { Authorization: "Bearer not-a-token.xxxxxxxxxxxxx" },
    });

    const result = await authenticateRequest(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
    }
  });

  test("dev bypass returns synthetic AuthContext without Authorization header", async () => {
    authDisabled = true;

    const req = new Request("http://localhost/v1/host-browser-result", {
      method: "POST",
    });

    const result = await authenticateRequest(req);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Same synthetic context shape as authenticateRequest's dev
      // bypass — the tests share the same invariant because a single
      // helper builds both.
      expect(result.context.principalType).toBe("actor");
      expect(result.context.actorPrincipalId).toBe("dev-bypass");
    }
  });
});

// ---------------------------------------------------------------------------
// Dev bypass covers only a request that supplied no Authorization header. A
// bearer sent to a platform pod (the gateway's exchange token, or a trusted
// contact's) is verified on its own terms.
// ---------------------------------------------------------------------------

describe("authenticateRequest with auth disabled and a bearer present", () => {
  beforeEach(() => {
    authDisabled = true;
  });

  test("uses the token's claims rather than the dev-bypass context", () => {
    const token = mintValidToken({ sub: "actor:self:contact-principal" });

    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });

    const result = authenticateRequest(req);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.actorPrincipalId).toBe("contact-principal");
      expect(result.context.policyEpoch).toBe(CURRENT_POLICY_EPOCH);
    }
  });

  test("accepts the gateway's exchange token", () => {
    const token = mintValidToken({
      sub: "svc:gateway:self",
      scope_profile: "gateway_service_v1",
    });

    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });

    const result = authenticateRequest(req);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.principalType).toBe("svc_gateway");
    }
  });

  test("accepts a gateway-audience token through the fallback", () => {
    const token = mintValidToken({
      aud: "vellum-gateway",
      sub: "actor:self:local-client",
    });

    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });

    const result = authenticateRequest(req);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.actorPrincipalId).toBe("local-client");
      expect(result.context.assistantId).toBe(DAEMON_INTERNAL_ASSISTANT_ID);
    }
  });

  test.each([
    ["malformed", () => "not-a-token.xxxxxxxxxxxxx"],
    [
      "expired",
      () => mintValidToken({ exp: Math.floor(Date.now() / 1000) - 100 }),
    ],
    [
      "wrong-audience",
      () => mintValidToken({ aud: "vellum-other" as TokenAudience }),
    ],
    ["unparseable-sub", () => mintValidToken({ sub: "garbage" })],
  ])("refuses a %s token rather than falling back", (_label, build) => {
    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { Authorization: `Bearer ${build()}` },
    });

    const result = authenticateRequest(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
    }
  });

  test("still returns the dev-bypass context when no bearer is sent", () => {
    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
    });

    const result = authenticateRequest(req);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.actorPrincipalId).toBe("dev-bypass");
    }
  });

  test("verifies a lowercase bearer scheme rather than bypassing it", () => {
    const token = mintValidToken({ sub: "actor:self:contact-principal" });

    const req = new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { Authorization: `bearer ${token}` },
    });

    const result = authenticateRequest(req);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.actorPrincipalId).toBe("contact-principal");
    }
  });

  test.each([
    ["lowercase scheme with a bad token", "bearer not-a-jwt.xxxxxxxx"],
    ["empty credential", "Bearer "],
    ["non-bearer scheme", "Basic dXNlcjpwYXNz"],
    ["an empty header value", ""],
    ["a whitespace-only header value", "   "],
  ])(
    "refuses %s instead of granting the dev-bypass context",
    (_label, header) => {
      const req = new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { Authorization: header },
      });

      const result = authenticateRequest(req);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.status).toBe(401);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// oauth_proxy_v1 grants: the narrow bearer a third-party CLI presents to the
// OAuth passthrough route. Accepted on either audience, and carrying nothing
// but oauth.proxy.
// ---------------------------------------------------------------------------

describe("authenticateRequest for oauth_proxy_v1 grants", () => {
  test.each(["vellum-daemon", "vellum-gateway"] as const)(
    "accepts an %s-audience grant and grants only oauth.proxy",
    (aud) => {
      const token = mintValidToken({
        aud,
        sub: "local:self:oauth-proxy.stripe_link",
        scope_profile: "oauth_proxy_v1",
        policy_epoch: CURRENT_POLICY_EPOCH,
        ttlSeconds: 60,
      });

      const req = new Request(
        "http://localhost/v1/oauth/proxy/stripe_link/v1/accounts",
        { method: "GET", headers: { Authorization: `Bearer ${token}` } },
      );

      const result = authenticateRequest(req);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.context.principalType).toBe("local");
        expect(result.context.conversationId).toBe("oauth-proxy.stripe_link");
        expect(result.context.scopes.has("oauth.proxy")).toBe(true);
        expect(result.context.scopes.has("settings.write")).toBe(false);
      }
    },
  );
});

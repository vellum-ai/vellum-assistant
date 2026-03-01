import { describe, expect, test } from "bun:test";

import { loadConfig } from "../config.js";
import {
  authenticateInternalRequest,
  ManagedGatewayInternalAuthError,
  withInternalAuth,
} from "../internal-auth.js";

const FAR_FUTURE = "2099-01-01T00:00:00.000Z";
const FAR_PAST = "2000-01-01T00:00:00.000Z";

type EnvOverrides = Record<string, string | undefined>;

function makeConfig(overrides: EnvOverrides): ReturnType<typeof loadConfig> {
  const baseEnv: NodeJS.ProcessEnv = {
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
    MANAGED_GATEWAY_INTERNAL_REVOKED_TOKEN_IDS: "",
    MANAGED_GATEWAY_INTERNAL_MTLS_PRINCIPALS: "managed-gateway-staging",
    MANAGED_GATEWAY_MTLS_PRINCIPAL_HEADER: "x-managed-gateway-principal",
    MANAGED_GATEWAY_MTLS_AUDIENCE_HEADER: "x-managed-gateway-audience",
    MANAGED_GATEWAY_MTLS_SCOPES_HEADER: "x-managed-gateway-scopes",
    ...overrides,
  };

  return loadConfig(baseEnv);
}

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request("http://managed-gateway.test/v1/internal/managed-gateway/routes/resolve/", {
    headers,
  });
}

describe("internal auth - bearer", () => {
  test("rejects missing bearer token", () => {
    const config = makeConfig({});

    expect(() =>
      authenticateInternalRequest(makeRequest(), config, "routes:resolve"),
    ).toThrow("Missing managed gateway bearer token.");
  });

  test("rejects unknown bearer token", () => {
    const config = makeConfig({});

    expect(() =>
      authenticateInternalRequest(
        makeRequest({ authorization: "Bearer token-unknown" }),
        config,
        "routes:resolve",
      ),
    ).toThrow("Unknown managed gateway bearer token.");
  });

  test("rejects expired bearer token", () => {
    const config = makeConfig({
      MANAGED_GATEWAY_INTERNAL_BEARER_TOKENS: JSON.stringify({
        "token-expired": {
          token_id: "mgw-expired",
          principal: "managed-gateway-staging",
          audience: "managed-gateway-internal",
          scopes: ["managed-gateway:internal", "routes:resolve"],
          expires_at: FAR_PAST,
        },
      }),
    });

    expect(() =>
      authenticateInternalRequest(
        makeRequest({ authorization: "Bearer token-expired" }),
        config,
        "routes:resolve",
      ),
    ).toThrow("Managed gateway bearer token is expired.");
  });

  test("rejects bearer token missing required scope", () => {
    const config = makeConfig({
      MANAGED_GATEWAY_INTERNAL_BEARER_TOKENS: JSON.stringify({
        "token-missing-scope": {
          token_id: "mgw-missing-scope",
          principal: "managed-gateway-staging",
          audience: "managed-gateway-internal",
          scopes: ["managed-gateway:internal"],
          expires_at: FAR_FUTURE,
        },
      }),
    });

    expect(() =>
      authenticateInternalRequest(
        makeRequest({ authorization: "Bearer token-missing-scope" }),
        config,
        "routes:resolve",
      ),
    ).toThrow("missing required scope routes:resolve");
  });

  test("rejects bearer audience mismatch", () => {
    const config = makeConfig({
      MANAGED_GATEWAY_INTERNAL_BEARER_TOKENS: JSON.stringify({
        "token-wrong-aud": {
          token_id: "mgw-wrong-aud",
          principal: "managed-gateway-staging",
          audience: "some-other-audience",
          scopes: ["managed-gateway:internal", "routes:resolve"],
          expires_at: FAR_FUTURE,
        },
      }),
    });

    expect(() =>
      authenticateInternalRequest(
        makeRequest({ authorization: "Bearer token-wrong-aud" }),
        config,
        "routes:resolve",
      ),
    ).toThrow("Managed gateway bearer audience mismatch.");
  });

  test("accepts valid bearer token", () => {
    const config = makeConfig({});

    const principal = authenticateInternalRequest(
      makeRequest({ authorization: "Bearer token-active" }),
      config,
      "routes:resolve",
    );

    expect(principal.principalId).toBe("managed-gateway-staging");
    expect(principal.authMode).toBe("bearer");
    expect(principal.audience).toBe("managed-gateway-internal");
    expect(principal.scopes).toContain("routes:resolve");
  });

  test("accepts rotated bearer tokens during overlap", () => {
    const config = makeConfig({
      MANAGED_GATEWAY_INTERNAL_BEARER_TOKENS: JSON.stringify({
        "token-old": {
          token_id: "mgw-2026-01",
          principal: "managed-gateway-staging",
          audience: "managed-gateway-internal",
          scopes: ["managed-gateway:internal", "routes:resolve"],
          expires_at: FAR_FUTURE,
        },
        "token-new": {
          token_id: "mgw-2026-02",
          principal: "managed-gateway-staging",
          audience: "managed-gateway-internal",
          scopes: ["managed-gateway:internal", "routes:resolve"],
          expires_at: FAR_FUTURE,
        },
      }),
    });

    expect(
      authenticateInternalRequest(
        makeRequest({ authorization: "Bearer token-old" }),
        config,
        "routes:resolve",
      ).principalId,
    ).toBe("managed-gateway-staging");

    expect(
      authenticateInternalRequest(
        makeRequest({ authorization: "Bearer token-new" }),
        config,
        "routes:resolve",
      ).principalId,
    ).toBe("managed-gateway-staging");
  });

  test("rejects revoked old token after rotation and accepts new token", () => {
    const config = makeConfig({
      MANAGED_GATEWAY_INTERNAL_BEARER_TOKENS: JSON.stringify({
        "token-old": {
          token_id: "mgw-2026-01",
          principal: "managed-gateway-staging",
          audience: "managed-gateway-internal",
          scopes: ["managed-gateway:internal", "routes:resolve"],
          expires_at: FAR_FUTURE,
        },
        "token-new": {
          token_id: "mgw-2026-02",
          principal: "managed-gateway-staging",
          audience: "managed-gateway-internal",
          scopes: ["managed-gateway:internal", "routes:resolve"],
          expires_at: FAR_FUTURE,
        },
      }),
      MANAGED_GATEWAY_INTERNAL_REVOKED_TOKEN_IDS: "mgw-2026-01",
    });

    expect(() =>
      authenticateInternalRequest(
        makeRequest({ authorization: "Bearer token-old" }),
        config,
        "routes:resolve",
      ),
    ).toThrow("Managed gateway bearer token has been revoked.");

    expect(
      authenticateInternalRequest(
        makeRequest({ authorization: "Bearer token-new" }),
        config,
        "routes:resolve",
      ).principalId,
    ).toBe("managed-gateway-staging");
  });
});

describe("internal auth - mtls", () => {
  test("rejects unauthorized mTLS principal", () => {
    const config = makeConfig({
      MANAGED_GATEWAY_INTERNAL_AUTH_MODE: "mtls",
      MANAGED_GATEWAY_INTERNAL_MTLS_PRINCIPALS: "managed-gateway-staging",
    });

    expect(() =>
      authenticateInternalRequest(
        makeRequest({
          "x-managed-gateway-principal": "managed-gateway-dev",
          "x-managed-gateway-audience": "managed-gateway-internal",
          "x-managed-gateway-scopes": "managed-gateway:internal,routes:resolve",
        }),
        config,
        "routes:resolve",
      ),
    ).toThrow("Managed gateway mTLS principal is not authorized.");
  });

  test("rejects mTLS scope mismatch", () => {
    const config = makeConfig({
      MANAGED_GATEWAY_INTERNAL_AUTH_MODE: "mtls",
      MANAGED_GATEWAY_INTERNAL_MTLS_PRINCIPALS: "managed-gateway-staging",
    });

    expect(() =>
      authenticateInternalRequest(
        makeRequest({
          "x-managed-gateway-principal": "managed-gateway-staging",
          "x-managed-gateway-audience": "managed-gateway-internal",
          "x-managed-gateway-scopes": "managed-gateway:internal",
        }),
        config,
        "routes:resolve",
      ),
    ).toThrow("missing required scope routes:resolve");
  });

  test("accepts valid mTLS principal, audience, and scope", () => {
    const config = makeConfig({
      MANAGED_GATEWAY_INTERNAL_AUTH_MODE: "mtls",
      MANAGED_GATEWAY_INTERNAL_MTLS_PRINCIPALS: "managed-gateway-staging",
    });

    const principal = authenticateInternalRequest(
      makeRequest({
        "x-managed-gateway-principal": "managed-gateway-staging",
        "x-managed-gateway-audience": "managed-gateway-internal",
        "x-managed-gateway-scopes": "managed-gateway:internal,routes:resolve",
      }),
      config,
      "routes:resolve",
    );

    expect(principal.authMode).toBe("mtls");
    expect(principal.principalId).toBe("managed-gateway-staging");
  });
});

describe("internal auth middleware", () => {
  test("returns explicit 401 envelope for auth errors", async () => {
    const config = makeConfig({});
    const handler = withInternalAuth(config, async () => {
      return Response.json({ ok: true });
    }, "routes:resolve");

    const response = await handler(makeRequest());

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: {
        code: "missing_bearer",
        detail: "Missing managed gateway bearer token.",
      },
    });
  });

  test("passes principal to handler when authentication succeeds", async () => {
    const config = makeConfig({});
    const handler = withInternalAuth(config, async (_request, principal) => {
      return Response.json({ principalId: principal.principalId, authMode: principal.authMode });
    }, "routes:resolve");

    const response = await handler(
      makeRequest({ authorization: "Bearer token-active" }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      principalId: "managed-gateway-staging",
      authMode: "bearer",
    });
  });

  test("throws typed auth error for inspection when needed", () => {
    const config = makeConfig({});

    try {
      authenticateInternalRequest(makeRequest(), config, "routes:resolve");
      throw new Error("Expected auth error");
    } catch (error) {
      expect(error instanceof ManagedGatewayInternalAuthError).toBe(true);
      if (error instanceof ManagedGatewayInternalAuthError) {
        expect(error.code).toBe("missing_bearer");
        expect(error.status).toBe(401);
      }
    }
  });
});

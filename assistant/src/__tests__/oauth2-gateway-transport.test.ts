import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the module under test
// ---------------------------------------------------------------------------

let mockPublicBaseUrl = "";

mock.module("../config/loader.js", () => ({
  loadConfig: () => ({
    ingress: { publicBaseUrl: mockPublicBaseUrl },
  }),
  getConfig: () => ({
    ui: {},

    ingress: { publicBaseUrl: mockPublicBaseUrl },
  }),
  loadRawConfig: () => ({}),
  saveConfig: () => {},
  invalidateConfigCache: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
    child: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    }),
  }),
}));

// Track registerPendingCallback calls
const pendingCallbacks: Map<
  string,
  { resolve: (code: string) => void; reject: (error: Error) => void }
> = new Map();

mock.module("../security/oauth-callback-registry.js", () => ({
  registerPendingCallback: (
    state: string,
    resolve: (code: string) => void,
    reject: (error: Error) => void,
  ) => {
    pendingCallbacks.set(state, { resolve, reject });
  },
  consumeCallback: () => true,
  consumeCallbackError: () => true,
  clearAllCallbacks: () => {
    pendingCallbacks.clear();
  },
}));

let mockOAuthCallbackUrl = "";

mock.module("../inbound/public-ingress-urls.js", () => ({
  getOAuthCallbackUrl: () => mockOAuthCallbackUrl,
  getPublicBaseUrl: (config?: { ingress?: { publicBaseUrl?: string } }) => {
    const url = config?.ingress?.publicBaseUrl ?? mockPublicBaseUrl;
    if (!url) {
      throw new Error("No public base URL configured.");
    }
    return url;
  },
}));

// Mock platform-callback-registration to avoid cold-start latency from its
// transitive dependencies (config/env.js, config/env-registry.js) which can
// cause the 10ms timer in the auto-detection test to fire before openUrl is called.
mock.module("../inbound/platform-callback-registration.js", () => ({
  shouldUsePlatformCallbacks: () => false,
  registerCallbackRoute: () => Promise.reject(new Error("not containerized")),
  resolveCallbackUrl: (directUrl: () => string) => Promise.resolve(directUrl()),
}));

// Track token exchange request
let lastTokenRequestBody: URLSearchParams | null = null;
let lastTokenRequestHeaders: Record<string, string> = {};

// Mock fetch for token exchange
let mockTokenResponse: {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
} = {
  ok: true,
  status: 200,
  body: {
    access_token: "test-access-token",
    refresh_token: "test-refresh-token",
    expires_in: 3600,
    scope: "read write",
    token_type: "Bearer",
  },
};

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  if (url.includes("token")) {
    // Capture request body and headers for assertions
    if (init?.body) {
      lastTokenRequestBody = new URLSearchParams(init.body as string);
    }
    if (init?.headers) {
      lastTokenRequestHeaders = init.headers as Record<string, string>;
    }
    if (!mockTokenResponse.ok) {
      return new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: mockTokenResponse.status,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify(mockTokenResponse.body), {
      status: mockTokenResponse.status,
      headers: { "Content-Type": "application/json" },
    });
  }
  return originalFetch(input, init);
}) as unknown as typeof fetch;

// ---------------------------------------------------------------------------
// Import module under test AFTER mocks are in place
// ---------------------------------------------------------------------------

import { type OAuth2Config, startOAuth2Flow } from "../security/oauth2.js";

const BASE_OAUTH_CONFIG: OAuth2Config = {
  authUrl: "https://provider.example.com/authorize",
  tokenUrl: "https://provider.example.com/token",
  scopes: ["read", "write"],
  clientId: "test-client-id",
};

beforeEach(() => {
  mockPublicBaseUrl = "";
  mockOAuthCallbackUrl = "https://gw.example.com/webhooks/oauth/callback";
  pendingCallbacks.clear();
  lastTokenRequestBody = null;
  lastTokenRequestHeaders = {};
  mockTokenResponse = {
    ok: true,
    status: 200,
    body: {
      access_token: "test-access-token",
      refresh_token: "test-refresh-token",
      expires_in: 3600,
      scope: "read write",
      token_type: "Bearer",
    },
  };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OAuth2 gateway transport", () => {
  describe("auto-detection", () => {
    test("selects gateway transport when ingress.publicBaseUrl is configured", async () => {
      mockPublicBaseUrl = "https://gw.example.com";

      let capturedAuthUrl = "";
      const flowPromise = startOAuth2Flow(BASE_OAUTH_CONFIG, {
        openUrl: (url) => {
          capturedAuthUrl = url;
        },
      });

      // Give the flow a tick to register the callback and open the browser
      await new Promise((r) => setTimeout(r, 10));

      // The auth URL should contain the gateway redirect_uri, not a loopback one
      expect(capturedAuthUrl).toContain("redirect_uri=");
      expect(capturedAuthUrl).not.toContain("127.0.0.1");
      expect(capturedAuthUrl).not.toMatch(/localhost:\d+/);
      expect(capturedAuthUrl).toContain(
        encodeURIComponent("https://gw.example.com"),
      );

      // Resolve the pending callback to complete the flow
      const entries = Array.from(pendingCallbacks.entries());
      expect(entries.length).toBe(1);
      const [, { resolve }] = entries[0];
      resolve("auth-code-from-gateway");

      const result = await flowPromise;
      expect(result.tokens.accessToken).toBe("test-access-token");
    });

    test("falls back to loopback transport when ingress.publicBaseUrl is not configured", async () => {
      mockPublicBaseUrl = "";

      let capturedAuthUrl = "";
      const flowPromise = startOAuth2Flow(BASE_OAUTH_CONFIG, {
        openUrl: (url) => {
          capturedAuthUrl = url;
        },
      });

      // Give the loopback server time to start
      await new Promise((r) => setTimeout(r, 50));

      // Auth URL should use a localhost redirect_uri
      expect(capturedAuthUrl).toContain("redirect_uri=");
      expect(capturedAuthUrl).toMatch(/localhost|127\.0\.0\.1/);
      expect(capturedAuthUrl).toContain(encodeURIComponent("/oauth/callback"));

      // Extract the redirect_uri and simulate the callback
      const authUrl = new URL(capturedAuthUrl);
      const redirectUri = authUrl.searchParams.get("redirect_uri")!;
      const state = authUrl.searchParams.get("state")!;

      // Make a request to the loopback server with the auth code
      const callbackUrl = `${redirectUri}?code=loopback-auth-code&state=${state}`;
      await fetch(callbackUrl);

      const result = await flowPromise;
      expect(result.tokens.accessToken).toBe("test-access-token");
    });
  });

  describe("explicit transport", () => {
    test("uses gateway transport when explicitly specified", async () => {
      mockPublicBaseUrl = "https://gw.example.com";

      let capturedAuthUrl = "";
      const flowPromise = startOAuth2Flow(
        BASE_OAUTH_CONFIG,
        {
          openUrl: (url) => {
            capturedAuthUrl = url;
          },
        },
        { callbackTransport: "gateway" },
      );

      await new Promise((r) => setTimeout(r, 10));

      expect(capturedAuthUrl).toContain(
        encodeURIComponent("https://gw.example.com"),
      );

      const entries = Array.from(pendingCallbacks.entries());
      expect(entries.length).toBe(1);
      entries[0][1].resolve("explicit-gateway-code");

      const result = await flowPromise;
      expect(result.tokens.accessToken).toBe("test-access-token");
    });

    test("uses loopback transport when explicitly specified", async () => {
      mockPublicBaseUrl = "https://gw.example.com";

      let capturedAuthUrl = "";
      const flowPromise = startOAuth2Flow(
        BASE_OAUTH_CONFIG,
        {
          openUrl: (url) => {
            capturedAuthUrl = url;
          },
        },
        { callbackTransport: "loopback" },
      );

      await new Promise((r) => setTimeout(r, 50));

      // Should use loopback redirect even though gateway URL is available
      expect(capturedAuthUrl).toMatch(/localhost|127\.0\.0\.1/);
      expect(capturedAuthUrl).not.toContain("gw.example.com");

      // Simulate callback to loopback server
      const authUrl = new URL(capturedAuthUrl);
      const redirectUri = authUrl.searchParams.get("redirect_uri")!;
      const state = authUrl.searchParams.get("state")!;
      await fetch(`${redirectUri}?code=explicit-loopback-code&state=${state}`);

      const result = await flowPromise;
      expect(result.tokens.accessToken).toBe("test-access-token");
    });

    test("throws when gateway transport is explicitly requested without public URL", async () => {
      mockPublicBaseUrl = "";

      await expect(
        startOAuth2Flow(
          BASE_OAUTH_CONFIG,
          { openUrl: () => {} },
          { callbackTransport: "gateway" },
        ),
      ).rejects.toThrow("Gateway transport requires a public ingress URL");
    });
  });

  describe("gateway transport flow", () => {
    test("success: register callback, consume with code, exchange for tokens", async () => {
      mockPublicBaseUrl = "https://gw.example.com";

      const flowPromise = startOAuth2Flow(
        BASE_OAUTH_CONFIG,
        { openUrl: () => {} },
        { callbackTransport: "gateway" },
      );

      await new Promise((r) => setTimeout(r, 10));

      // A callback should be registered
      const entries = Array.from(pendingCallbacks.entries());
      expect(entries.length).toBe(1);

      // Simulate gateway delivering the authorization code
      const [state, { resolve }] = entries[0];
      expect(typeof state).toBe("string");
      expect(state.length).toBeGreaterThan(0);

      resolve("gateway-auth-code");

      const result = await flowPromise;
      expect(result.tokens.accessToken).toBe("test-access-token");
      expect(result.tokens.refreshToken).toBe("test-refresh-token");
      expect(result.tokens.expiresIn).toBe(3600);
      expect(result.grantedScopes).toEqual(["read", "write"]);
    });

    test("error: register callback, consume with error, rejects", async () => {
      mockPublicBaseUrl = "https://gw.example.com";

      const flowPromise = startOAuth2Flow(
        BASE_OAUTH_CONFIG,
        { openUrl: () => {} },
        { callbackTransport: "gateway" },
      );

      await new Promise((r) => setTimeout(r, 10));

      const entries = Array.from(pendingCallbacks.entries());
      expect(entries.length).toBe(1);

      // Simulate the gateway delivering an error (e.g. user denied access)
      const [, { reject }] = entries[0];
      reject(new Error("OAuth2 authorization denied: access_denied"));

      await expect(flowPromise).rejects.toThrow(
        "OAuth2 authorization denied: access_denied",
      );
    });

    test("token exchange failure propagates error", async () => {
      mockPublicBaseUrl = "https://gw.example.com";
      mockTokenResponse = {
        ok: false,
        status: 400,
        body: { error: "invalid_grant" },
      };

      const flowPromise = startOAuth2Flow(
        BASE_OAUTH_CONFIG,
        { openUrl: () => {} },
        { callbackTransport: "gateway" },
      );

      await new Promise((r) => setTimeout(r, 10));

      const entries = Array.from(pendingCallbacks.entries());
      entries[0][1].resolve("code-that-fails-exchange");

      await expect(flowPromise).rejects.toThrow("OAuth2 token exchange failed");
    });
  });

  describe("loopback transport flow", () => {
    test("success: starts server, receives callback, exchanges for tokens", async () => {
      let capturedAuthUrl = "";
      let urlReady!: () => void;
      const urlReadyPromise = new Promise<void>((r) => {
        urlReady = r;
      });
      const flowPromise = startOAuth2Flow(
        BASE_OAUTH_CONFIG,
        {
          openUrl: (url) => {
            capturedAuthUrl = url;
            urlReady();
          },
        },
        { callbackTransport: "loopback" },
      );

      await urlReadyPromise;

      expect(capturedAuthUrl).toContain("redirect_uri=");
      expect(capturedAuthUrl).toMatch(/localhost|127\.0\.0\.1/);
      expect(capturedAuthUrl).toContain("code_challenge=");
      expect(capturedAuthUrl).toContain("code_challenge_method=S256");

      const authUrl = new URL(capturedAuthUrl);
      const redirectUri = authUrl.searchParams.get("redirect_uri")!;
      const state = authUrl.searchParams.get("state")!;

      const resp = await fetch(
        `${redirectUri}?code=loopback-code&state=${state}`,
      );
      expect(resp.status).toBe(200);
      const html = await resp.text();
      expect(html).toContain("Authorization Successful");

      const result = await flowPromise;
      expect(result.tokens.accessToken).toBe("test-access-token");
      expect(result.tokens.refreshToken).toBe("test-refresh-token");
    });

    test("error: OAuth provider returns error parameter", async () => {
      let capturedAuthUrl = "";
      let urlReady!: () => void;
      const urlReadyPromise = new Promise<void>((r) => {
        urlReady = r;
      });
      const flowPromise = startOAuth2Flow(
        BASE_OAUTH_CONFIG,
        {
          openUrl: (url) => {
            capturedAuthUrl = url;
            urlReady();
          },
        },
        { callbackTransport: "loopback" },
      );

      await urlReadyPromise;

      const authUrl = new URL(capturedAuthUrl);
      const redirectUri = authUrl.searchParams.get("redirect_uri")!;
      const state = authUrl.searchParams.get("state")!;

      // Fire callback without awaiting — immediately check flowPromise rejection
      fetch(`${redirectUri}?error=access_denied&state=${state}`).catch(
        () => {},
      );

      await expect(flowPromise).rejects.toThrow(
        "OAuth2 authorization denied: access_denied",
      );
    });

    test("rejects callback with wrong state parameter", async () => {
      let capturedAuthUrl = "";
      let urlReady!: () => void;
      const urlReadyPromise = new Promise<void>((r) => {
        urlReady = r;
      });
      const flowPromise = startOAuth2Flow(
        BASE_OAUTH_CONFIG,
        {
          openUrl: (url) => {
            capturedAuthUrl = url;
            urlReady();
          },
        },
        { callbackTransport: "loopback" },
      );

      await urlReadyPromise;

      const authUrl = new URL(capturedAuthUrl);
      const redirectUri = authUrl.searchParams.get("redirect_uri")!;

      // Send callback with wrong state
      const resp = await fetch(
        `${redirectUri}?code=bad-code&state=wrong-state`,
      );
      expect(resp.status).toBe(400);

      // The flow should still be waiting (not resolved)
      // Send the correct callback to clean up
      const state = authUrl.searchParams.get("state")!;
      await fetch(`${redirectUri}?code=correct-code&state=${state}`);

      const result = await flowPromise;
      expect(result.tokens.accessToken).toBe("test-access-token");
    });

    test("token exchange failure propagates error", async () => {
      mockTokenResponse = {
        ok: false,
        status: 400,
        body: { error: "invalid_grant" },
      };

      let capturedAuthUrl = "";
      let urlReady!: () => void;
      const urlReadyPromise = new Promise<void>((r) => {
        urlReady = r;
      });
      const flowPromise = startOAuth2Flow(
        BASE_OAUTH_CONFIG,
        {
          openUrl: (url) => {
            capturedAuthUrl = url;
            urlReady();
          },
        },
        { callbackTransport: "loopback" },
      );

      await urlReadyPromise;

      const authUrl = new URL(capturedAuthUrl);
      const redirectUri = authUrl.searchParams.get("redirect_uri")!;
      const state = authUrl.searchParams.get("state")!;

      // Fire callback without awaiting — immediately check flowPromise rejection
      fetch(`${redirectUri}?code=code-that-fails&state=${state}`).catch(
        () => {},
      );

      await expect(flowPromise).rejects.toThrow("OAuth2 token exchange failed");
    });
  });

  describe("PKCE with client secret", () => {
    test("includes PKCE params in auth URL even when clientSecret is provided", async () => {
      mockPublicBaseUrl = "https://gw.example.com";

      const configWithSecret: OAuth2Config = {
        ...BASE_OAUTH_CONFIG,
        clientSecret: "test-client-secret",
      };

      let capturedAuthUrl = "";
      const flowPromise = startOAuth2Flow(configWithSecret, {
        openUrl: (url) => {
          capturedAuthUrl = url;
        },
      });

      await new Promise((r) => setTimeout(r, 10));

      // Auth URL must include PKCE challenge params despite having a client secret
      expect(capturedAuthUrl).toContain("code_challenge=");
      expect(capturedAuthUrl).toContain("code_challenge_method=S256");

      const entries = Array.from(pendingCallbacks.entries());
      expect(entries.length).toBe(1);
      entries[0][1].resolve("pkce-with-secret-code");

      const result = await flowPromise;
      expect(result.tokens.accessToken).toBe("test-access-token");

      // Token exchange must include code_verifier
      expect(lastTokenRequestBody).not.toBeNull();
      expect(lastTokenRequestBody!.get("code_verifier")).toBeTruthy();
    });

    test("sends Basic Auth header and omits client_id/client_secret from body when tokenEndpointAuthMethod is client_secret_basic", async () => {
      mockPublicBaseUrl = "https://gw.example.com";

      const configWithSecret: OAuth2Config = {
        ...BASE_OAUTH_CONFIG,
        clientSecret: "test-client-secret",
        tokenEndpointAuthMethod: "client_secret_basic",
      };

      const flowPromise = startOAuth2Flow(configWithSecret, {
        openUrl: () => {},
      });

      await new Promise((r) => setTimeout(r, 10));

      const entries = Array.from(pendingCallbacks.entries());
      entries[0][1].resolve("basic-auth-code");

      await flowPromise;

      // Should send Basic Auth header with base64(client_id:client_secret)
      const expectedCredentials = Buffer.from(
        "test-client-id:test-client-secret",
      ).toString("base64");
      expect(lastTokenRequestHeaders["Authorization"]).toBe(
        `Basic ${expectedCredentials}`,
      );

      // Body should NOT contain client_id or client_secret
      expect(lastTokenRequestBody).not.toBeNull();
      expect(lastTokenRequestBody!.has("client_id")).toBe(false);
      expect(lastTokenRequestBody!.has("client_secret")).toBe(false);

      // Body should still contain code_verifier
      expect(lastTokenRequestBody!.get("code_verifier")).toBeTruthy();
    });

    test("sends client_id and client_secret in body when tokenEndpointAuthMethod is client_secret_post (default)", async () => {
      mockPublicBaseUrl = "https://gw.example.com";

      const configWithSecret: OAuth2Config = {
        ...BASE_OAUTH_CONFIG,
        clientSecret: "test-client-secret",
      };

      const flowPromise = startOAuth2Flow(configWithSecret, {
        openUrl: () => {},
      });

      await new Promise((r) => setTimeout(r, 10));

      const entries = Array.from(pendingCallbacks.entries());
      entries[0][1].resolve("post-auth-code");

      await flowPromise;

      // No Authorization header for client_secret_post
      expect(lastTokenRequestHeaders["Authorization"]).toBeUndefined();

      // Body should contain client_id and client_secret
      expect(lastTokenRequestBody).not.toBeNull();
      expect(lastTokenRequestBody!.get("client_id")).toBe("test-client-id");
      expect(lastTokenRequestBody!.get("client_secret")).toBe(
        "test-client-secret",
      );
    });

    test("sends client_id in body without Basic Auth when no clientSecret", async () => {
      mockPublicBaseUrl = "https://gw.example.com";

      const flowPromise = startOAuth2Flow(BASE_OAUTH_CONFIG, {
        openUrl: () => {},
      });

      await new Promise((r) => setTimeout(r, 10));

      const entries = Array.from(pendingCallbacks.entries());
      entries[0][1].resolve("public-client-code");

      await flowPromise;

      // No Authorization header for public clients
      expect(lastTokenRequestHeaders["Authorization"]).toBeUndefined();

      // Body should contain client_id
      expect(lastTokenRequestBody).not.toBeNull();
      expect(lastTokenRequestBody!.get("client_id")).toBe("test-client-id");
      expect(lastTokenRequestBody!.has("client_secret")).toBe(false);
    });
  });
});

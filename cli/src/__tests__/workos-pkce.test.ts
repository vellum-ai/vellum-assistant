import { afterEach, describe, expect, mock, test } from "bun:test";

import {
  buildAuthorizeUrl,
  exchangeAccessTokenForSession,
  exchangeCodeWithWorkos,
  fetchWorkosClientId,
  generatePkcePair,
  selectWorkosClientId,
} from "../lib/workos-pkce.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/**
 * Route fetch responses by URL substring so each WorkOS/platform call can be
 * inspected. The module talks to remote hosts via loopbackSafeFetch, which
 * delegates to globalThis.fetch.
 */
function mockFetchByUrl(responses: Record<string, () => Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = mock(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      const match = Object.entries(responses).find(([prefix]) =>
        url.includes(prefix),
      );
      if (!match) throw new Error(`Unexpected fetch: ${url}`);
      return match[1]();
    },
  ) as unknown as typeof globalThis.fetch;
  return calls;
}

describe("generatePkcePair", () => {
  test("challenge is the base64url sha256 of the verifier", async () => {
    const { verifier, challenge } = generatePkcePair();
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(verifier),
    );
    const expected = Buffer.from(digest).toString("base64url");
    expect(challenge).toBe(expected);
  });

  test("verifiers are unique", () => {
    expect(generatePkcePair().verifier).not.toBe(generatePkcePair().verifier);
  });
});

describe("buildAuthorizeUrl", () => {
  const base = {
    clientId: "client_123",
    redirectUri: "http://127.0.0.1:4242/auth/callback",
    challenge: "chal",
    state: "st",
  };

  test("targets user_management/authorize with PKCE and authkit defaults", () => {
    const url = new URL(buildAuthorizeUrl(base));
    expect(url.origin).toBe("https://api.workos.com");
    expect(url.pathname).toBe("/user_management/authorize");
    expect(url.searchParams.get("client_id")).toBe("client_123");
    expect(url.searchParams.get("redirect_uri")).toBe(base.redirectUri);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("openid profile email");
    expect(url.searchParams.get("code_challenge")).toBe("chal");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("st");
    expect(url.searchParams.get("provider")).toBe("authkit");
    // Session reuse: never force a fresh IdP login.
    expect(url.searchParams.has("prompt")).toBe(false);
  });

  test("login hint is forwarded", () => {
    const url = new URL(
      buildAuthorizeUrl({ ...base, loginHint: "user@example.com" }),
    );
    expect(url.searchParams.get("login_hint")).toBe("user@example.com");

    const noHint = new URL(buildAuthorizeUrl(base));
    expect(noHint.searchParams.has("login_hint")).toBe(false);
  });
});

describe("selectWorkosClientId", () => {
  // During coexistence the platform lists two providers that share the
  // "workos-oidc" id; only the OAuth2 one (no discovery URL) is usable.
  const legacy = {
    id: "workos-oidc",
    name: "WorkOS OIDC",
    client_id: "client_connect",
    flows: ["provider_redirect", "provider_token"],
    openid_configuration_url:
      "https://x.authkit.app/.well-known/openid-configuration",
  };
  const modern = {
    id: "workos-oidc",
    name: "WorkOS",
    client_id: "client_um",
    flows: ["provider_redirect", "provider_token"],
  };

  test("picks the OAuth2 entry during coexistence", () => {
    expect(selectWorkosClientId([legacy, modern])).toBe("client_um");
    expect(selectWorkosClientId([modern, legacy])).toBe("client_um");
  });

  test("returns null when the platform lacks token auth", () => {
    const preTokenAuth = { ...modern, flows: ["provider_redirect"] };
    expect(selectWorkosClientId([legacy, preTokenAuth])).toBeNull();
    expect(selectWorkosClientId([])).toBeNull();
  });

  test("ignores an entry missing client_id", () => {
    const noClientId = { id: "workos-oidc", flows: ["provider_token"] };
    expect(selectWorkosClientId([noClientId])).toBeNull();
  });
});

describe("fetchWorkosClientId", () => {
  test("resolves the client id from the headless config", async () => {
    const calls = mockFetchByUrl({
      "/_allauth/app/v1/config": () =>
        new Response(
          JSON.stringify({
            data: {
              socialaccount: {
                providers: [
                  {
                    id: "workos-oidc",
                    client_id: "client_um",
                    flows: ["provider_token"],
                  },
                ],
              },
            },
          }),
          { status: 200 },
        ),
    });

    expect(await fetchWorkosClientId("https://platform.example")).toBe(
      "client_um",
    );
    expect(calls[0]!.url).toBe(
      "https://platform.example/_allauth/app/v1/config",
    );
  });

  test("derives the config URL from the origin, ignoring any path", async () => {
    const calls = mockFetchByUrl({
      "/_allauth/app/v1/config": () =>
        new Response(
          JSON.stringify({
            data: {
              socialaccount: {
                providers: [
                  { client_id: "client_um", flows: ["provider_token"] },
                ],
              },
            },
          }),
          { status: 200 },
        ),
    });

    await fetchWorkosClientId("https://platform.example/some/path");
    expect(calls[0]!.url).toBe(
      "https://platform.example/_allauth/app/v1/config",
    );
  });

  test("throws a clear error when no token-auth provider is advertised", async () => {
    mockFetchByUrl({
      "/_allauth/app/v1/config": () =>
        new Response(
          JSON.stringify({ data: { socialaccount: { providers: [] } } }),
          { status: 200 },
        ),
    });

    await expect(
      fetchWorkosClientId("https://platform.example"),
    ).rejects.toThrow(/does not advertise/);
  });

  test("throws on a non-OK config response", async () => {
    mockFetchByUrl({
      "/_allauth/app/v1/config": () => new Response("nope", { status: 500 }),
    });

    await expect(
      fetchWorkosClientId("https://platform.example"),
    ).rejects.toThrow(/500/);
  });
});

describe("exchangeCodeWithWorkos", () => {
  test("posts a public-client PKCE exchange and returns the access token", async () => {
    const calls = mockFetchByUrl({
      "/user_management/authenticate": () =>
        new Response(JSON.stringify({ access_token: "at_1", user: {} }), {
          status: 200,
        }),
    });

    const token = await exchangeCodeWithWorkos({
      clientId: "client_um",
      code: "c",
      verifier: "v",
    });

    expect(token).toBe("at_1");
    expect(calls[0]!.url).toBe(
      "https://api.workos.com/user_management/authenticate",
    );
    const body = JSON.parse(String(calls[0]!.init?.body));
    // Public client: no secret, no API key.
    expect(body).toEqual({
      client_id: "client_um",
      grant_type: "authorization_code",
      code: "c",
      code_verifier: "v",
    });
  });

  test("throws with upstream detail on failure", async () => {
    mockFetchByUrl({
      "/user_management/authenticate": () =>
        new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
        }),
    });

    await expect(
      exchangeCodeWithWorkos({ clientId: "c", code: "x", verifier: "v" }),
    ).rejects.toThrow(/400/);
  });

  test("throws when the exchange returns no access token", async () => {
    mockFetchByUrl({
      "/user_management/authenticate": () =>
        new Response(JSON.stringify({}), { status: 200 }),
    });

    await expect(
      exchangeCodeWithWorkos({ clientId: "c", code: "x", verifier: "v" }),
    ).rejects.toThrow(/no access token/);
  });
});

describe("exchangeAccessTokenForSession", () => {
  test("posts the headless token payload and returns the session token", async () => {
    const calls = mockFetchByUrl({
      "/_allauth/app/v1/auth/provider/token": () =>
        new Response(JSON.stringify({ meta: { session_token: "sess_1" } }), {
          status: 200,
        }),
    });

    const token = await exchangeAccessTokenForSession(
      "https://platform.example",
      "client_um",
      "at_1",
    );

    expect(token).toBe("sess_1");
    expect(calls[0]!.url).toBe(
      "https://platform.example/_allauth/app/v1/auth/provider/token",
    );
    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body).toEqual({
      provider: "workos",
      process: "login",
      token: { client_id: "client_um", access_token: "at_1" },
    });
  });

  test("throws on a rejected token", async () => {
    mockFetchByUrl({
      "/_allauth/app/v1/auth/provider/token": () =>
        new Response(JSON.stringify({ errors: [{ code: "invalid_token" }] }), {
          status: 400,
        }),
    });

    await expect(
      exchangeAccessTokenForSession("https://platform.example", "c", "bad"),
    ).rejects.toThrow(/400/);
  });

  test("throws when the session exchange returns no session token", async () => {
    mockFetchByUrl({
      "/_allauth/app/v1/auth/provider/token": () =>
        new Response(JSON.stringify({ meta: {} }), { status: 200 }),
    });

    await expect(
      exchangeAccessTokenForSession("https://platform.example", "c", "at"),
    ).rejects.toThrow(/no session token/);
  });
});

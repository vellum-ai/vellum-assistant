import { afterEach, describe, expect, mock, test } from "bun:test";

// net.fetch routes by URL so each WorkOS/platform call can be asserted.
let fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
let fetchResponses: Record<string, () => Response> = {};

mock.module("electron", () => ({
  net: {
    fetch: (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, init });
      const match = Object.entries(fetchResponses).find(([prefix]) =>
        url.includes(prefix),
      );
      if (!match) throw new Error(`Unexpected fetch: ${url}`);
      return Promise.resolve(match[1]());
    },
  },
}));

const {
  buildAuthorizeUrl,
  exchangeAccessTokenForSession,
  exchangeCodeWithWorkos,
  fetchWorkosClientId,
  generatePkcePair,
  selectWorkosClientId,
  startLoopbackListener,
} = await import("./workos-pkce");

afterEach(() => {
  fetchCalls = [];
  fetchResponses = {};
});

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
    expect(url.searchParams.get("code_challenge")).toBe("chal");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("st");
    expect(url.searchParams.get("provider")).toBe("authkit");
    expect(url.searchParams.get("scope")).toBe("openid profile email");
    // Session reuse: never force a fresh IdP login.
    expect(url.searchParams.has("prompt")).toBe(false);
  });

  test("signup intent maps to screen_hint", () => {
    const url = new URL(buildAuthorizeUrl({ ...base, intent: "signup" }));
    expect(url.searchParams.get("screen_hint")).toBe("sign-up");

    const noIntent = new URL(buildAuthorizeUrl(base));
    expect(noIntent.searchParams.has("screen_hint")).toBe(false);
  });

  test("login hint is forwarded", () => {
    const url = new URL(buildAuthorizeUrl({ ...base, loginHint: "user@example.com" }));
    expect(url.searchParams.get("login_hint")).toBe("user@example.com");
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
    openid_configuration_url: "https://x.authkit.app/.well-known/openid-configuration",
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
});

describe("fetchWorkosClientId", () => {
  test("resolves the client id from the headless config", async () => {
    fetchResponses["/_allauth/app/v1/config"] = () =>
      new Response(
        JSON.stringify({
          data: {
            socialaccount: {
              providers: [
                { id: "workos-oidc", client_id: "client_um", flows: ["provider_token"] },
              ],
            },
          },
        }),
        { status: 200 },
      );

    expect(await fetchWorkosClientId("https://platform.example")).toBe("client_um");
    expect(fetchCalls[0]!.url).toBe("https://platform.example/_allauth/app/v1/config");
  });

  test("throws a clear error when no token-auth provider is advertised", async () => {
    fetchResponses["/_allauth/app/v1/config"] = () =>
      new Response(JSON.stringify({ data: { socialaccount: { providers: [] } } }), {
        status: 200,
      });

    await expect(fetchWorkosClientId("https://platform.example")).rejects.toThrow(
      /does not advertise/,
    );
  });
});

describe("startLoopbackListener", () => {
  test("delivers the code for a state-matched callback and ignores noise", async () => {
    const listener = await startLoopbackListener("expected-state");
    try {
      // Noise: wrong path, wrong state — must not settle the promise.
      const noise1 = await fetch(listener.redirectUri.replace("/auth/callback", "/favicon.ico"));
      expect(noise1.status).toBe(404);
      const noise2 = await fetch(`${listener.redirectUri}?code=evil&state=wrong`);
      expect(noise2.status).toBe(404);

      const ok = await fetch(`${listener.redirectUri}?code=good-code&state=expected-state`);
      expect(ok.status).toBe(200);
      expect(await ok.text()).toContain("You're all set");
      expect(await listener.waitForCode).toBe("good-code");
    } finally {
      listener.close();
    }
  });

  test("rejects on an error callback", async () => {
    const listener = await startLoopbackListener("st");
    try {
      // Attach a handler before triggering so the rejection is never
      // momentarily unhandled (bun reports those as test errors).
      const settled = listener.waitForCode.then(
        () => null,
        (err: Error) => err,
      );
      const res = await fetch(`${listener.redirectUri}?error=access_denied&state=st`);
      expect(res.status).toBe(200);
      const err = await settled;
      expect(err?.message).toMatch(/access_denied/);
    } finally {
      listener.close();
    }
  });

  test("close rejects pending waiters with the given reason", async () => {
    const listener = await startLoopbackListener("st");
    const settled = listener.waitForCode.then(
      () => null,
      (err: Error) => err,
    );
    listener.close("Sign-in timed out.");
    const err = await settled;
    expect(err?.message).toMatch(/timed out/);
  });
});

describe("exchangeCodeWithWorkos", () => {
  test("posts a public-client PKCE exchange and returns the access token", async () => {
    fetchResponses["/user_management/authenticate"] = () =>
      new Response(JSON.stringify({ access_token: "at_1", user: {} }), { status: 200 });

    const token = await exchangeCodeWithWorkos({
      clientId: "client_um",
      code: "c",
      verifier: "v",
    });

    expect(token).toBe("at_1");
    const body = JSON.parse(String(fetchCalls[0]!.init?.body));
    expect(body).toEqual({
      client_id: "client_um",
      grant_type: "authorization_code",
      code: "c",
      code_verifier: "v",
    });
  });

  test("throws with upstream detail on failure", async () => {
    fetchResponses["/user_management/authenticate"] = () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });

    await expect(
      exchangeCodeWithWorkos({ clientId: "c", code: "x", verifier: "v" }),
    ).rejects.toThrow(/400/);
  });
});

describe("exchangeAccessTokenForSession", () => {
  test("posts the headless token payload and returns the session token", async () => {
    fetchResponses["/_allauth/app/v1/auth/provider/token"] = () =>
      new Response(JSON.stringify({ meta: { session_token: "sess_1" } }), {
        status: 200,
      });

    const token = await exchangeAccessTokenForSession(
      "https://platform.example",
      "client_um",
      "at_1",
    );

    expect(token).toBe("sess_1");
    expect(fetchCalls[0]!.url).toBe(
      "https://platform.example/_allauth/app/v1/auth/provider/token",
    );
    const body = JSON.parse(String(fetchCalls[0]!.init?.body));
    expect(body).toEqual({
      provider: "workos",
      process: "login",
      token: { client_id: "client_um", access_token: "at_1" },
    });
  });

  test("throws on a rejected token", async () => {
    fetchResponses["/_allauth/app/v1/auth/provider/token"] = () =>
      new Response(JSON.stringify({ errors: [{ code: "invalid_token" }] }), {
        status: 400,
      });

    await expect(
      exchangeAccessTokenForSession("https://platform.example", "c", "bad"),
    ).rejects.toThrow(/400/);
  });
});

import {
  afterEach,
  describe,
  expect,
  mock,
  setSystemTime,
  test,
} from "bun:test";

import { createWebLoginFlow, sanitizeLoginReturnTo } from "../lib/web-login";

const PLATFORM_URL = "https://platform.example";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  setSystemTime();
});

/** Route fetch responses by URL substring (same pattern as workos-pkce.test.ts). */
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

function configResponse(): Response {
  return new Response(
    JSON.stringify({
      data: {
        socialaccount: {
          providers: [
            {
              id: "workos-oidc",
              name: "WorkOS",
              client_id: "client_um_test",
              flows: ["provider_redirect", "provider_token"],
            },
          ],
        },
      },
    }),
    { status: 200 },
  );
}

function happyPathMocks() {
  return mockFetchByUrl({
    "/_allauth/app/v1/config": configResponse,
    "/user_management/authenticate": () =>
      new Response(JSON.stringify({ access_token: "access-token-abc" }), {
        status: 200,
      }),
    "/_allauth/app/v1/auth/provider/token": () =>
      new Response(JSON.stringify({ meta: { session_token: "sesstok123" } }), {
        status: 200,
      }),
  });
}

function makeFlow() {
  const installed: string[] = [];
  const flow = createWebLoginFlow({
    platformUrl: PLATFORM_URL,
    installToken: (token) => installed.push(token),
  });
  return { flow, installed };
}

async function startAndGetAuthorizeUrl(
  flow: ReturnType<typeof createWebLoginFlow>,
  startUrl = "http://localhost:3000/__local/login/start?returnTo=/assistant/settings",
): Promise<URL> {
  const res = await flow.handleStart(new URL(startUrl));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { authorizeUrl: string };
  return new URL(body.authorizeUrl);
}

describe("sanitizeLoginReturnTo", () => {
  test("keeps relative paths", () => {
    expect(sanitizeLoginReturnTo("/assistant/settings")).toBe(
      "/assistant/settings",
    );
  });

  test.each([
    null,
    "",
    "https://evil.example/phish",
    "//evil.example",
    "/\\evil.example",
    "assistant",
  ])("falls back for %p", (value) => {
    expect(sanitizeLoginReturnTo(value as string | null)).toBe("/assistant/");
  });
});

describe("handleStart", () => {
  test("returns a WorkOS authorize URL with PKCE + loopback redirect", async () => {
    happyPathMocks();
    const { flow } = makeFlow();
    const authorize = await startAndGetAuthorizeUrl(flow);

    expect(authorize.origin).toBe("https://api.workos.com");
    expect(authorize.pathname).toBe("/user_management/authorize");
    expect(authorize.searchParams.get("client_id")).toBe("client_um_test");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:3000/auth/callback",
    );
    expect(authorize.searchParams.get("state")).toMatch(/^[0-9a-f]{64}$/);
    expect(authorize.searchParams.get("screen_hint")).toBeNull();
  });

  test("signup intent sets screen_hint", async () => {
    happyPathMocks();
    const { flow } = makeFlow();
    const authorize = await startAndGetAuthorizeUrl(
      flow,
      "http://localhost:3000/__local/login/start?intent=signup",
    );
    expect(authorize.searchParams.get("screen_hint")).toBe("sign-up");
  });

  test("unreachable platform yields a 502 with the error", async () => {
    mockFetchByUrl({
      "/_allauth/app/v1/config": () => new Response("nope", { status: 503 }),
    });
    const { flow, installed } = makeFlow();
    const res = await flow.handleStart(
      new URL("http://localhost:3000/__local/login/start"),
    );
    expect(res.status).toBe(502);
    expect(installed).toEqual([]);
  });
});

describe("handleCallback", () => {
  test("happy path installs the token and 302s to the sanitized returnTo", async () => {
    happyPathMocks();
    const { flow, installed } = makeFlow();
    const authorize = await startAndGetAuthorizeUrl(flow);
    const state = authorize.searchParams.get("state")!;

    const res = await flow.handleCallback(
      new URL(
        `http://127.0.0.1:3000/auth/callback?code=authcode&state=${state}`,
      ),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "http://localhost:3000/assistant/settings",
    );
    expect(installed).toEqual(["sesstok123"]);
  });

  test("state mismatch → 404, nothing installed", async () => {
    happyPathMocks();
    const { flow, installed } = makeFlow();
    await startAndGetAuthorizeUrl(flow);

    const res = await flow.handleCallback(
      new URL("http://127.0.0.1:3000/auth/callback?code=authcode&state=wrong"),
    );
    expect(res.status).toBe(404);
    expect(installed).toEqual([]);
  });

  test("no pending login → 404", async () => {
    happyPathMocks();
    const { flow, installed } = makeFlow();
    const res = await flow.handleCallback(
      new URL("http://127.0.0.1:3000/auth/callback?code=authcode&state=any"),
    );
    expect(res.status).toBe(404);
    expect(installed).toEqual([]);
  });

  test("state is single-use: replay → 404, token installed once", async () => {
    happyPathMocks();
    const { flow, installed } = makeFlow();
    const authorize = await startAndGetAuthorizeUrl(flow);
    const state = authorize.searchParams.get("state")!;
    const callbackUrl = new URL(
      `http://127.0.0.1:3000/auth/callback?code=authcode&state=${state}`,
    );

    expect((await flow.handleCallback(callbackUrl)).status).toBe(302);
    expect((await flow.handleCallback(callbackUrl)).status).toBe(404);
    expect(installed).toEqual(["sesstok123"]);
  });

  test("expired pending login → 404", async () => {
    happyPathMocks();
    const { flow, installed } = makeFlow();
    const authorize = await startAndGetAuthorizeUrl(flow);
    const state = authorize.searchParams.get("state")!;

    setSystemTime(new Date(Date.now() + 121_000));
    const res = await flow.handleCallback(
      new URL(
        `http://127.0.0.1:3000/auth/callback?code=authcode&state=${state}`,
      ),
    );
    expect(res.status).toBe(404);
    expect(installed).toEqual([]);
  });

  test("exchange failure surfaces an error page, not a redirect", async () => {
    mockFetchByUrl({
      "/_allauth/app/v1/config": configResponse,
      "/user_management/authenticate": () =>
        new Response("denied", { status: 400 }),
    });
    const { flow, installed } = makeFlow();
    const authorize = await startAndGetAuthorizeUrl(flow);
    const state = authorize.searchParams.get("state")!;

    const res = await flow.handleCallback(
      new URL(`http://127.0.0.1:3000/auth/callback?code=bad&state=${state}`),
    );
    expect(res.status).toBe(502);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(installed).toEqual([]);
  });
});

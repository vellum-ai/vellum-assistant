import { afterEach, describe, expect, mock, test } from "bun:test";

// --- Mocks (installed before the `await import` of the module under test) ---

// Capture IPC registrations so tests can invoke the handlers directly.
const ipcHandlers: Record<string, (args: unknown[]) => unknown> = {};
const ipcSyncHandlers: Record<string, () => unknown> = {};

mock.module("./ipc", () => ({
  handle: (
    channel: string,
    _schema: unknown,
    fn: (args: unknown[]) => unknown,
  ) => {
    ipcHandlers[channel] = fn;
  },
  handleSync: (channel: string, fn: () => unknown) => {
    ipcSyncHandlers[channel] = fn;
  },
}));

// Capture the OAuth start URL so tests can read back the generated `state`.
let lastOpenedUrl = "";

// Capture legacy-cookie eviction calls.
const cookieRemoveCalls: Array<{ url: string; name: string }> = [];

mock.module("electron", () => ({
  app: { getVersion: () => "9.9.9", getPath: () => "/tmp" },
  net: {
    // Routed by URL: serves the real workos-pkce module's three network
    // legs (config discovery, WorkOS code exchange, session exchange) and
    // the legacy /accounts/native/exchange.
    fetch: (url: string) => {
      let body: unknown;
      if (url.includes("/_allauth/app/v1/config")) {
        body = {
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
        };
      } else if (url.includes("/user_management/authenticate")) {
        body = { access_token: "access-token-abc", user: {} };
      } else if (url.includes("/_allauth/app/v1/auth/provider/token")) {
        body = { meta: { session_token: "sess-tok-123" } };
      } else {
        body = { session_token: "sess-tok-123" };
      }
      return Promise.resolve(
        new Response(JSON.stringify(body), { status: 200 }),
      );
    },
  },
  session: {
    defaultSession: {
      cookies: {
        remove: (url: string, name: string) => {
          cookieRemoveCalls.push({ url, name });
          return Promise.resolve();
        },
      },
    },
  },
  shell: {
    openExternal: (url: string) => {
      lastOpenedUrl = url;
      return Promise.resolve();
    },
  },
}));

mock.module("@vellumai/local-mode", () => ({
  resolveLocalConfigFromEnv: () => ({
    webUrl: "https://web.example",
    platformUrl: "https://platform.example",
  }),
}));

// Capture session-token-store interactions.
const store = {
  saved: [] as string[],
  clearCalls: 0,
};

mock.module("./session-token-store", () => ({
  saveSessionToken: (token: string) => {
    store.saved.push(token);
  },
  clearSessionToken: () => {
    store.clearCalls += 1;
  },
  getSessionToken: () => store.saved.at(-1) ?? null,
}));

const { generateState, installNativeAuth, __resetForTesting } = await import(
  "./native-auth"
);

afterEach(() => {
  __resetForTesting();
  store.saved.length = 0;
  store.clearCalls = 0;
  lastOpenedUrl = "";
  cookieRemoveCalls.length = 0;
  for (const key of Object.keys(ipcHandlers)) delete ipcHandlers[key];
  for (const key of Object.keys(ipcSyncHandlers)) delete ipcSyncHandlers[key];
});

describe("generateState", () => {
  test("returns a base64url-encoded string of sufficient length", () => {
    const state = generateState();
    expect(state.length).toBeGreaterThanOrEqual(16);
    expect(/^[A-Za-z0-9_-]+$/.test(state)).toBe(true);
  });

  test("generates unique values", () => {
    const a = generateState();
    const b = generateState();
    expect(a).not.toBe(b);
  });
});

describe("installNativeAuth — session-token wiring", () => {
  test("persists the exchanged token on successful PKCE login", async () => {
    installNativeAuth();

    const startOAuth = ipcHandlers["vellum:auth:startOAuth"];
    expect(startOAuth).toBeDefined();

    const pending = startOAuth([{}]) as Promise<{ sessionToken: string }>;

    // Wait for the async setup (config fetch + listener bind) to open the
    // browser at the WorkOS authorize URL.
    while (!lastOpenedUrl) await Bun.sleep(1);
    const opened = new URL(lastOpenedUrl);
    expect(opened.pathname).toBe("/user_management/authorize");
    expect(opened.searchParams.get("client_id")).toBe("client_um_test");
    expect(opened.searchParams.get("code_challenge_method")).toBe("S256");

    // Play the browser: hit the real loopback listener with the code.
    const redirectUri = opened.searchParams.get("redirect_uri")!;
    const state = opened.searchParams.get("state")!;
    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
    const res = await fetch(`${redirectUri}?code=auth-code-xyz&state=${state}`);
    expect(res.status).toBe(200);

    const result = await pending;
    expect(result.sessionToken).toBe("sess-tok-123");
    expect(store.saved).toContain("sess-tok-123");
  });

  test("evicts both legacy session cookies on install", () => {
    installNativeAuth();
    // Eviction fires synchronously (Promise.all over the cookie names).
    const names = cookieRemoveCalls.map((c) => c.name);
    expect(names).toContain("sessionid");
    expect(names).toContain("__Secure-sessionid");
    expect(cookieRemoveCalls.every((c) => c.url === "https://platform.example")).toBe(
      true,
    );
  });

  test("signOut clears the persisted token", async () => {
    installNativeAuth();

    const signOut = ipcHandlers["vellum:auth:signOut"];
    expect(signOut).toBeDefined();

    await signOut([]);
    expect(store.clearCalls).toBe(1);
  });

  test("exposes the cached token over sync IPC", () => {
    installNativeAuth();
    store.saved.push("cached-tok");

    const getToken = ipcSyncHandlers["vellum:auth:getSessionToken"];
    expect(getToken).toBeDefined();
    expect(getToken()).toBe("cached-tok");
  });
});

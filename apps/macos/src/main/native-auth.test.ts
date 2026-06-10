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
    fetch: () =>
      Promise.resolve(
        new Response(JSON.stringify({ session_token: "sess-tok-123" }), {
          status: 200,
        }),
      ),
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

const {
  buildStartUrl,
  generateState,
  handleAuthCallback,
  installNativeAuth,
  __resetForTesting,
} = await import("./native-auth");

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

describe("buildStartUrl", () => {
  test("builds URL with required state param", () => {
    const url = buildStartUrl("https://platform.vellum.ai", "abc123", {});
    expect(url).toBe(
      "https://platform.vellum.ai/accounts/native/start?state=abc123",
    );
  });

  test("includes optional params when provided", () => {
    const url = buildStartUrl("https://platform.vellum.ai", "abc123", {
      providerHint: "GoogleOAuth",
      loginHint: "user@example.com",
      clientVersion: "1.0.0",
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get("state")).toBe("abc123");
    expect(parsed.searchParams.get("provider_hint")).toBe("GoogleOAuth");
    expect(parsed.searchParams.get("login_hint")).toBe("user@example.com");
    expect(parsed.searchParams.get("client_version")).toBe("1.0.0");
  });

  test("omits optional params when not provided", () => {
    const url = buildStartUrl("https://platform.vellum.ai", "abc123", {});
    const parsed = new URL(url);
    expect(parsed.searchParams.has("provider_hint")).toBe(false);
    expect(parsed.searchParams.has("login_hint")).toBe(false);
    expect(parsed.searchParams.has("client_version")).toBe(false);
  });
});

describe("installNativeAuth — session-token wiring", () => {
  test("persists the exchanged token on successful login", async () => {
    installNativeAuth();

    const startOAuth = ipcHandlers["vellum:auth:startOAuth"];
    expect(startOAuth).toBeDefined();

    const pending = startOAuth([{}]) as Promise<{ sessionToken: string }>;

    // openExternal ran synchronously in the flow's executor, so the start URL
    // (with the state) is already captured.
    const state = new URL(lastOpenedUrl).searchParams.get("state");
    expect(state).toBeTruthy();

    await handleAuthCallback(state!, "auth-code-xyz");
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

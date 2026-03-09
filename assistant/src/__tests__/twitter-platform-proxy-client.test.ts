import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock dependencies — must be before importing the module under test
// ---------------------------------------------------------------------------

let mockApiKey: string | undefined = "test-api-key-123";
let mockPlatformEnvUrl = "https://platform.vellum.ai";
let mockPlatformAssistantId = "ast_abc123";
let mockConfigBaseUrl = "";

mock.module("../security/secure-keys.js", () => ({
  getSecureKey: (account: string) => {
    if (account === "credential:vellum:assistant_api_key") return mockApiKey;
    return undefined;
  },
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    platform: { baseUrl: mockConfigBaseUrl },
  }),
}));

mock.module("../config/env.js", () => ({
  getPlatformBaseUrl: () => mockPlatformEnvUrl,
  getPlatformAssistantId: () => mockPlatformAssistantId,
}));

mock.module("../util/logger.js", () => ({
  getLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

// Mock global fetch
let lastFetchArgs: [string, RequestInit] | null = null;
let fetchResponse: {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
} = {
  ok: true,
  status: 200,
  json: async () => ({}),
};

globalThis.fetch = (async (url: string, init: RequestInit) => {
  lastFetchArgs = [url, init];
  return fetchResponse;
}) as typeof globalThis.fetch;

// Import after mocking
import {
  getMe,
  postTweet,
  proxyTwitterCall,
  resolveAuthToken,
  resolvePlatformAssistantId,
  resolvePlatformBaseUrl,
  resolvePrerequisites,
  TwitterProxyError,
} from "../twitter/platform-proxy-client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockApiKey = "test-api-key-123";
  mockPlatformEnvUrl = "https://platform.vellum.ai";
  mockPlatformAssistantId = "ast_abc123";
  mockConfigBaseUrl = "";
  lastFetchArgs = null;
  fetchResponse = {
    ok: true,
    status: 200,
    json: async () => ({
      status: 200,
      headers: {},
      body: { data: { id: "12345", text: "Hello world" } },
    }),
  };
});

// ---------------------------------------------------------------------------
// Prerequisite resolution
// ---------------------------------------------------------------------------

describe("prerequisite resolution", () => {
  test("resolvePlatformBaseUrl prefers config over env", () => {
    mockConfigBaseUrl = "https://config.vellum.ai";
    mockPlatformEnvUrl = "https://env.vellum.ai";
    expect(resolvePlatformBaseUrl()).toBe("https://config.vellum.ai");
  });

  test("resolvePlatformBaseUrl falls back to env when config is empty", () => {
    mockConfigBaseUrl = "";
    mockPlatformEnvUrl = "https://env.vellum.ai";
    expect(resolvePlatformBaseUrl()).toBe("https://env.vellum.ai");
  });

  test("resolvePlatformBaseUrl strips trailing slashes", () => {
    mockPlatformEnvUrl = "https://platform.vellum.ai///";
    expect(resolvePlatformBaseUrl()).toBe("https://platform.vellum.ai");
  });

  test("resolveAuthToken returns the token from secure storage", () => {
    expect(resolveAuthToken()).toBe("test-api-key-123");
  });

  test("resolveAuthToken returns undefined when token is missing", () => {
    mockApiKey = undefined;
    expect(resolveAuthToken()).toBeUndefined();
  });

  test("resolvePlatformAssistantId returns the env value", () => {
    expect(resolvePlatformAssistantId()).toBe("ast_abc123");
  });

  test("resolvePrerequisites returns all values when present", () => {
    const prereqs = resolvePrerequisites();
    expect(prereqs.platformBaseUrl).toBe("https://platform.vellum.ai");
    expect(prereqs.authToken).toBe("test-api-key-123");
    expect(prereqs.platformAssistantId).toBe("ast_abc123");
  });

  test("resolvePrerequisites throws when platform assistant ID is missing", () => {
    mockPlatformAssistantId = "";
    try {
      resolvePrerequisites();
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(TwitterProxyError);
      const tpe = err as TwitterProxyError;
      expect(tpe.code).toBe("missing_platform_assistant_id");
      expect(tpe.message).toBe("Local assistant not registered with platform");
      expect(tpe.retryable).toBe(false);
    }
  });

  test("resolvePrerequisites throws when assistant API key is missing", () => {
    mockApiKey = undefined;
    try {
      resolvePrerequisites();
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(TwitterProxyError);
      const tpe = err as TwitterProxyError;
      expect(tpe.code).toBe("missing_assistant_api_key");
      expect(tpe.message).toBe("Assistant not bootstrapped — run setup");
    }
  });

  test("resolvePrerequisites throws when platform base URL is missing", () => {
    mockPlatformEnvUrl = "";
    mockConfigBaseUrl = "";
    try {
      resolvePrerequisites();
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(TwitterProxyError);
      const tpe = err as TwitterProxyError;
      expect(tpe.code).toBe("missing_platform_base_url");
      expect(tpe.message).toBe("Platform base URL is not configured");
    }
  });
});

// ---------------------------------------------------------------------------
// Proxy calls
// ---------------------------------------------------------------------------

describe("proxyTwitterCall", () => {
  test("sends POST to the correct proxy endpoint", async () => {
    await proxyTwitterCall({
      method: "POST",
      path: "/2/tweets",
      body: { text: "Hello" },
    });

    expect(lastFetchArgs).not.toBeNull();
    expect(lastFetchArgs![0]).toBe(
      "https://platform.vellum.ai/v1/assistants/ast_abc123/external-provider-proxy/twitter/",
    );
    expect(lastFetchArgs![1].method).toBe("POST");
  });

  test("sends Api-Key authorization header with assistant API key", async () => {
    await proxyTwitterCall({
      method: "GET",
      path: "/2/users/me",
    });

    expect(lastFetchArgs).not.toBeNull();
    const headers = lastFetchArgs![1].headers as Record<string, string>;
    expect(headers.Authorization).toBe("Api-Key test-api-key-123");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  test("request body contains the Twitter API call description", async () => {
    await proxyTwitterCall({
      method: "POST",
      path: "/2/tweets",
      body: { text: "Hello world" },
    });

    const parsed = JSON.parse(lastFetchArgs![1].body as string);
    expect(parsed.request.method).toBe("POST");
    expect(parsed.request.path).toBe("/2/tweets");
    expect(parsed.request.body).toEqual({ text: "Hello world" });
  });

  test("GET-style request includes query parameters", async () => {
    await proxyTwitterCall({
      method: "GET",
      path: "/2/users/me",
      query: { "user.fields": "name,username" },
    });

    const parsed = JSON.parse(lastFetchArgs![1].body as string);
    expect(parsed.request.method).toBe("GET");
    expect(parsed.request.path).toBe("/2/users/me");
    expect(parsed.request.query).toEqual({ "user.fields": "name,username" });
  });

  test("returns parsed response data on success", async () => {
    fetchResponse = {
      ok: true,
      status: 200,
      json: async () => ({
        status: 200,
        headers: {},
        body: { data: { id: "99", text: "ok" } },
      }),
    };

    const result = await proxyTwitterCall({
      method: "POST",
      path: "/2/tweets",
      body: { text: "ok" },
    });

    expect(result.data).toEqual({ data: { id: "99", text: "ok" } });
    expect(result.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

describe("error mapping", () => {
  test("403 with owner credential message maps to owner_credential_required", async () => {
    fetchResponse = {
      ok: false,
      status: 403,
      json: async () => ({
        detail: "Owner credential required to access this resource",
      }),
    };

    try {
      await proxyTwitterCall({ method: "GET", path: "/2/users/me" });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(TwitterProxyError);
      const tpe = err as TwitterProxyError;
      expect(tpe.code).toBe("owner_credential_required");
      expect(tpe.message).toBe(
        "Connect Twitter in Settings as the assistant owner",
      );
      expect(tpe.retryable).toBe(false);
      expect(tpe.statusCode).toBe(403);
    }
  });

  test("403 with owner-only message maps to owner_only", async () => {
    fetchResponse = {
      ok: false,
      status: 403,
      json: async () => ({
        detail: "Only the owner can perform this action",
      }),
    };

    try {
      await proxyTwitterCall({ method: "POST", path: "/2/tweets", body: {} });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(TwitterProxyError);
      const tpe = err as TwitterProxyError;
      expect(tpe.code).toBe("owner_only");
      expect(tpe.message).toBe("Sign in as the assistant owner");
    }
  });

  test("403 without owner keyword maps to generic forbidden", async () => {
    fetchResponse = {
      ok: false,
      status: 403,
      json: async () => ({ detail: "Access denied" }),
    };

    try {
      await proxyTwitterCall({ method: "GET", path: "/2/users/me" });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(TwitterProxyError);
      const tpe = err as TwitterProxyError;
      expect(tpe.code).toBe("forbidden");
      expect(tpe.statusCode).toBe(403);
    }
  });

  test("401 maps to auth_failure with retryable true", async () => {
    fetchResponse = {
      ok: false,
      status: 401,
      json: async () => ({ detail: "Token expired" }),
    };

    try {
      await proxyTwitterCall({ method: "GET", path: "/2/users/me" });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(TwitterProxyError);
      const tpe = err as TwitterProxyError;
      expect(tpe.code).toBe("auth_failure");
      expect(tpe.message).toBe("Reconnect Twitter or retry");
      expect(tpe.retryable).toBe(true);
    }
  });

  test("502 maps to upstream_failure with retryable true", async () => {
    fetchResponse = {
      ok: false,
      status: 502,
      json: async () => ({}),
    };

    try {
      await proxyTwitterCall({ method: "GET", path: "/2/users/me" });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(TwitterProxyError);
      const tpe = err as TwitterProxyError;
      expect(tpe.code).toBe("upstream_failure");
      expect(tpe.retryable).toBe(true);
    }
  });

  test("429 maps to rate_limit with retryable true", async () => {
    fetchResponse = {
      ok: false,
      status: 429,
      json: async () => ({ detail: "Too many requests" }),
    };

    try {
      await proxyTwitterCall({ method: "POST", path: "/2/tweets", body: {} });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(TwitterProxyError);
      const tpe = err as TwitterProxyError;
      expect(tpe.code).toBe("rate_limit");
      expect(tpe.retryable).toBe(true);
      expect(tpe.statusCode).toBe(429);
    }
  });

  test("500 maps to platform_error with retryable true", async () => {
    fetchResponse = {
      ok: false,
      status: 500,
      json: async () => ({ detail: "Internal server error" }),
    };

    try {
      await proxyTwitterCall({ method: "GET", path: "/2/users/me" });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(TwitterProxyError);
      const tpe = err as TwitterProxyError;
      expect(tpe.code).toBe("platform_error");
      expect(tpe.retryable).toBe(true);
    }
  });

  test("unparseable error response falls back to status code", async () => {
    fetchResponse = {
      ok: false,
      status: 400,
      json: async () => {
        throw new Error("not json");
      },
    };

    try {
      await proxyTwitterCall({ method: "GET", path: "/2/users/me" });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(TwitterProxyError);
      const tpe = err as TwitterProxyError;
      expect(tpe.code).toBe("proxy_error");
      expect(tpe.message).toContain("HTTP 400");
    }
  });
});

// ---------------------------------------------------------------------------
// Convenience helpers
// ---------------------------------------------------------------------------

describe("postTweet", () => {
  test("sends a tweet through the proxy", async () => {
    await postTweet("Hello from proxy");

    const parsed = JSON.parse(lastFetchArgs![1].body as string);
    expect(parsed.request.method).toBe("POST");
    expect(parsed.request.path).toBe("/2/tweets");
    expect(parsed.request.body.text).toBe("Hello from proxy");
  });

  test("includes reply metadata when replyToId is provided", async () => {
    await postTweet("This is a reply", { replyToId: "tweet_789" });

    const parsed = JSON.parse(lastFetchArgs![1].body as string);
    expect(parsed.request.body.reply).toEqual({
      in_reply_to_tweet_id: "tweet_789",
    });
  });
});

describe("getMe", () => {
  test("sends a GET request for the authenticated user", async () => {
    await getMe({ "user.fields": "name,username,profile_image_url" });

    const parsed = JSON.parse(lastFetchArgs![1].body as string);
    expect(parsed.request.method).toBe("GET");
    expect(parsed.request.path).toBe("/2/users/me");
    expect(parsed.request.query).toEqual({
      "user.fields": "name,username,profile_image_url",
    });
  });

  test("sends without query when none provided", async () => {
    await getMe();

    const parsed = JSON.parse(lastFetchArgs![1].body as string);
    expect(parsed.request.method).toBe("GET");
    expect(parsed.request.path).toBe("/2/users/me");
    expect(parsed.request.query).toBeUndefined();
  });
});

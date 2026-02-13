import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { loadConfig } from "../config.js";

const BASE_ENV = {
  TELEGRAM_BOT_TOKEN: "tok",
  TELEGRAM_WEBHOOK_SECRET: "wh-sec",
  ASSISTANT_RUNTIME_BASE_URL: "http://localhost:7821",
};

function withEnv(overrides: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  const allKeys = [
    ...Object.keys(BASE_ENV),
    ...Object.keys(overrides),
    "GATEWAY_RUNTIME_PROXY_ENABLED",
    "GATEWAY_RUNTIME_PROXY_REQUIRE_AUTH",
    "RUNTIME_PROXY_BEARER_TOKEN",
    "GATEWAY_ASSISTANT_ROUTING_JSON",
    "GATEWAY_DEFAULT_ASSISTANT_ID",
    "GATEWAY_UNMAPPED_POLICY",
    "GATEWAY_PORT",
    "GATEWAY_SHUTDOWN_DRAIN_MS",
  ];

  for (const key of allKeys) {
    saved[key] = process.env[key];
    delete process.env[key];
  }

  Object.assign(process.env, BASE_ENV, overrides);

  try {
    fn();
  } finally {
    for (const key of allKeys) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  }
}

describe("config: Telegram-only default mode", () => {
  test("proxy is disabled when GATEWAY_RUNTIME_PROXY_ENABLED is unset", () => {
    withEnv({}, () => {
      const config = loadConfig();
      expect(config.runtimeProxyEnabled).toBe(false);
    });
  });

  test("proxy is disabled when GATEWAY_RUNTIME_PROXY_ENABLED is explicitly false", () => {
    withEnv({ GATEWAY_RUNTIME_PROXY_ENABLED: "false" }, () => {
      const config = loadConfig();
      expect(config.runtimeProxyEnabled).toBe(false);
    });
  });
});

describe("config: runtime proxy flags", () => {
  test("proxy disabled by default", () => {
    withEnv({}, () => {
      const config = loadConfig();
      expect(config.runtimeProxyEnabled).toBe(false);
      expect(config.runtimeProxyRequireAuth).toBe(true);
      expect(config.runtimeProxyBearerToken).toBeUndefined();
    });
  });

  test("proxy enabled with auth and valid token", () => {
    withEnv(
      {
        GATEWAY_RUNTIME_PROXY_ENABLED: "true",
        RUNTIME_PROXY_BEARER_TOKEN: "secret-key",
      },
      () => {
        const config = loadConfig();
        expect(config.runtimeProxyEnabled).toBe(true);
        expect(config.runtimeProxyRequireAuth).toBe(true);
        expect(config.runtimeProxyBearerToken).toBe("secret-key");
      },
    );
  });

  test("proxy enabled with auth disabled (no token needed)", () => {
    withEnv(
      {
        GATEWAY_RUNTIME_PROXY_ENABLED: "true",
        GATEWAY_RUNTIME_PROXY_REQUIRE_AUTH: "false",
      },
      () => {
        const config = loadConfig();
        expect(config.runtimeProxyEnabled).toBe(true);
        expect(config.runtimeProxyRequireAuth).toBe(false);
        expect(config.runtimeProxyBearerToken).toBeUndefined();
      },
    );
  });

  test("proxy enabled with auth required but no token throws", () => {
    withEnv(
      {
        GATEWAY_RUNTIME_PROXY_ENABLED: "true",
        GATEWAY_RUNTIME_PROXY_REQUIRE_AUTH: "true",
      },
      () => {
        expect(() => loadConfig()).toThrow(
          "RUNTIME_PROXY_BEARER_TOKEN is required when proxy is enabled with auth required",
        );
      },
    );
  });

  test("proxy disabled ignores missing token even with auth required", () => {
    withEnv(
      {
        GATEWAY_RUNTIME_PROXY_ENABLED: "false",
        GATEWAY_RUNTIME_PROXY_REQUIRE_AUTH: "true",
      },
      () => {
        const config = loadConfig();
        expect(config.runtimeProxyEnabled).toBe(false);
      },
    );
  });

  test("proxy enabled defaults auth to required", () => {
    withEnv(
      {
        GATEWAY_RUNTIME_PROXY_ENABLED: "true",
        RUNTIME_PROXY_BEARER_TOKEN: "my-token",
      },
      () => {
        const config = loadConfig();
        expect(config.runtimeProxyRequireAuth).toBe(true);
      },
    );
  });
});

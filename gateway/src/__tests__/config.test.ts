import { writeFileSync, unlinkSync } from "node:fs";
import { describe, test, expect } from "bun:test";
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
    "RUNTIME_BEARER_TOKEN",
    "RUNTIME_PROXY_BEARER_TOKEN",
    "GATEWAY_ASSISTANT_ROUTING_JSON",
    "GATEWAY_DEFAULT_ASSISTANT_ID",
    "GATEWAY_UNMAPPED_POLICY",
    "GATEWAY_PORT",
    "GATEWAY_SHUTDOWN_DRAIN_MS",
    "GATEWAY_RUNTIME_TIMEOUT_MS",
    "GATEWAY_RUNTIME_MAX_RETRIES",
    "GATEWAY_RUNTIME_INITIAL_BACKOFF_MS",
    "GATEWAY_TELEGRAM_TIMEOUT_MS",
    "GATEWAY_MAX_WEBHOOK_PAYLOAD_BYTES",
    "GATEWAY_MAX_ATTACHMENT_BYTES",
    "GATEWAY_MAX_ATTACHMENT_CONCURRENCY",
    "VELLUM_HTTP_TOKEN_PATH",
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
    withEnv({ VELLUM_HTTP_TOKEN_PATH: "/nonexistent/http-token" }, () => {
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
        VELLUM_HTTP_TOKEN_PATH: "/nonexistent/http-token",
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
        VELLUM_HTTP_TOKEN_PATH: "/nonexistent/http-token",
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
        VELLUM_HTTP_TOKEN_PATH: "/nonexistent/http-token",
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
        VELLUM_HTTP_TOKEN_PATH: "/nonexistent/http-token",
      },
      () => {
        const config = loadConfig();
        expect(config.runtimeProxyRequireAuth).toBe(true);
      },
    );
  });

  test("reads bearer token from http-token file when available", () => {
    /** Verifies the gateway reads the daemon's http-token file for auth. */
    withEnv(
      {
        GATEWAY_RUNTIME_PROXY_ENABLED: "true",
        VELLUM_HTTP_TOKEN_PATH: "/tmp/test-http-token",
      },
      () => {
        // GIVEN an http-token file exists with a known token
        writeFileSync("/tmp/test-http-token", "file-based-token\n");

        // WHEN we load the config
        const config = loadConfig();

        // THEN the bearer token is read from the file (trimmed)
        expect(config.runtimeProxyBearerToken).toBe("file-based-token");

        // AND cleanup
        unlinkSync("/tmp/test-http-token");
      },
    );
  });

  test("env var takes precedence over http-token file", () => {
    /** Verifies that the env var is preferred over the http-token file. */
    withEnv(
      {
        GATEWAY_RUNTIME_PROXY_ENABLED: "true",
        RUNTIME_PROXY_BEARER_TOKEN: "env-token",
        VELLUM_HTTP_TOKEN_PATH: "/tmp/test-http-token-priority",
      },
      () => {
        // GIVEN an http-token file exists with a different token than the env var
        writeFileSync("/tmp/test-http-token-priority", "file-token");

        // WHEN we load the config
        const config = loadConfig();

        // THEN the env var token takes precedence
        expect(config.runtimeProxyBearerToken).toBe("env-token");

        // AND cleanup
        unlinkSync("/tmp/test-http-token-priority");
      },
    );
  });

  test("falls back to env var when http-token file is missing", () => {
    /** Verifies fallback to RUNTIME_PROXY_BEARER_TOKEN env var. */
    withEnv(
      {
        GATEWAY_RUNTIME_PROXY_ENABLED: "true",
        RUNTIME_PROXY_BEARER_TOKEN: "env-fallback-token",
        VELLUM_HTTP_TOKEN_PATH: "/nonexistent/http-token",
      },
      () => {
        // GIVEN the http-token file does not exist
        // WHEN we load the config
        const config = loadConfig();

        // THEN the env var token is used as fallback
        expect(config.runtimeProxyBearerToken).toBe("env-fallback-token");
      },
    );
  });
});

describe("config: runtime bearer token", () => {
  test("runtimeBearerToken is undefined when env is unset and http-token file is missing", () => {
    withEnv({ VELLUM_HTTP_TOKEN_PATH: "/nonexistent/http-token" }, () => {
      const config = loadConfig();
      expect(config.runtimeBearerToken).toBeUndefined();
    });
  });

  test("runtimeBearerToken is set from RUNTIME_BEARER_TOKEN env var", () => {
    withEnv({ RUNTIME_BEARER_TOKEN: "rt-secret", VELLUM_HTTP_TOKEN_PATH: "/nonexistent/http-token" }, () => {
      const config = loadConfig();
      expect(config.runtimeBearerToken).toBe("rt-secret");
    });
  });

  test("runtimeBearerToken is read from http-token file when env var is unset", () => {
    withEnv({ VELLUM_HTTP_TOKEN_PATH: "/tmp/test-runtime-http-token" }, () => {
      writeFileSync("/tmp/test-runtime-http-token", "runtime-file-token\n");
      const config = loadConfig();
      expect(config.runtimeBearerToken).toBe("runtime-file-token");
      unlinkSync("/tmp/test-runtime-http-token");
    });
  });

  test("RUNTIME_BEARER_TOKEN env var takes precedence over http-token file", () => {
    withEnv(
      {
        RUNTIME_BEARER_TOKEN: "runtime-env-token",
        VELLUM_HTTP_TOKEN_PATH: "/tmp/test-runtime-http-token-priority",
      },
      () => {
        writeFileSync("/tmp/test-runtime-http-token-priority", "runtime-file-token");
        const config = loadConfig();
        expect(config.runtimeBearerToken).toBe("runtime-env-token");
        unlinkSync("/tmp/test-runtime-http-token-priority");
      },
    );
  });
});

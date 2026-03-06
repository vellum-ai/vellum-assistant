import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { describe, test, expect } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.js";

const BASE_ENV = {
  TELEGRAM_BOT_TOKEN: "tok",
  TELEGRAM_WEBHOOK_SECRET: "wh-sec",
  ASSISTANT_RUNTIME_BASE_URL: "http://localhost:7821",
};

async function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<void>,
) {
  const saved: Record<string, string | undefined> = {};
  const allKeys = [
    ...Object.keys(BASE_ENV),
    ...Object.keys(overrides),
    "GATEWAY_RUNTIME_PROXY_ENABLED",
    "GATEWAY_RUNTIME_PROXY_REQUIRE_AUTH",
    "RUNTIME_BEARER_TOKEN",
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
    "GATEWAY_TELEGRAM_DELIVER_AUTH_BYPASS",
    "VELLUM_HTTP_TOKEN_PATH",
    "BASE_DATA_DIR",
  ];

  for (const key of allKeys) {
    saved[key] = process.env[key];
    delete process.env[key];
  }

  Object.assign(process.env, BASE_ENV, overrides);

  try {
    await fn();
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
  test("proxy is disabled when GATEWAY_RUNTIME_PROXY_ENABLED is unset", async () => {
    await withEnv({}, async () => {
      const config = await loadConfig();
      expect(config.runtimeProxyEnabled).toBe(false);
    });
  });

  test("proxy is disabled when GATEWAY_RUNTIME_PROXY_ENABLED is explicitly false", async () => {
    await withEnv({ GATEWAY_RUNTIME_PROXY_ENABLED: "false" }, async () => {
      const config = await loadConfig();
      expect(config.runtimeProxyEnabled).toBe(false);
    });
  });
});

describe("config: runtime proxy flags", () => {
  test("proxy disabled by default", async () => {
    await withEnv({}, async () => {
      const config = await loadConfig();
      expect(config.runtimeProxyEnabled).toBe(false);
      expect(config.runtimeProxyRequireAuth).toBe(true);
    });
  });

  test("proxy enabled with auth disabled", async () => {
    await withEnv(
      {
        GATEWAY_RUNTIME_PROXY_ENABLED: "true",
        GATEWAY_RUNTIME_PROXY_REQUIRE_AUTH: "false",
      },
      async () => {
        const config = await loadConfig();
        expect(config.runtimeProxyEnabled).toBe(true);
        expect(config.runtimeProxyRequireAuth).toBe(false);
      },
    );
  });

  test("proxy disabled ignores auth setting", async () => {
    await withEnv(
      {
        GATEWAY_RUNTIME_PROXY_ENABLED: "false",
        GATEWAY_RUNTIME_PROXY_REQUIRE_AUTH: "true",
      },
      async () => {
        const config = await loadConfig();
        expect(config.runtimeProxyEnabled).toBe(false);
      },
    );
  });

  test("proxy enabled defaults auth to required", async () => {
    await withEnv(
      {
        GATEWAY_RUNTIME_PROXY_ENABLED: "true",
      },
      async () => {
        const config = await loadConfig();
        expect(config.runtimeProxyRequireAuth).toBe(true);
      },
    );
  });
});

describe("config: twilio assistant phone number mapping", () => {
  test("loads assistantPhoneNumbers from workspace config on startup", async () => {
    const testBaseDir = mkdtempSync(join(tmpdir(), "gateway-config-test-"));
    try {
      const workspaceDir = join(testBaseDir, ".vellum", "workspace");
      mkdirSync(workspaceDir, { recursive: true });
      writeFileSync(
        join(workspaceDir, "config.json"),
        JSON.stringify({
          twilio: {
            phoneNumber: "+15550001111",
            assistantPhoneNumbers: {
              "asst-alpha": "+15550002222",
              "asst-beta": "+15550003333",
            },
          },
        }),
      );

      await withEnv({ BASE_DATA_DIR: testBaseDir }, async () => {
        const config = await loadConfig();
        expect(config.assistantPhoneNumbers).toEqual({
          "asst-alpha": "+15550002222",
          "asst-beta": "+15550003333",
        });
      });
    } finally {
      rmSync(testBaseDir, { recursive: true, force: true });
    }
  });
});

import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = process.env.VELLUM_WORKSPACE_DIR!;
const secureStorePath = join(testDir, "keys.enc");
const metadataPath = join(testDir, "metadata.json");
const originalVellumDev = process.env.VELLUM_DEV;

process.env.VELLUM_DEV = "1";

// In-memory config store for tests
let configStore: Record<string, unknown> = {};

function setNestedValue(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const keys = path.split(".");
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (current[key] == null || typeof current[key] !== "object") {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]] = value;
}

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    slack: {
      deliverAuthBypass: false,
      teamId:
        ((configStore.slack as Record<string, unknown>)?.teamId as string) ??
        "",
      teamName:
        ((configStore.slack as Record<string, unknown>)?.teamName as string) ??
        "",
      botUserId:
        ((configStore.slack as Record<string, unknown>)?.botUserId as string) ??
        "",
      botUsername:
        ((configStore.slack as Record<string, unknown>)
          ?.botUsername as string) ?? "",
    },
  }),
  loadConfig: () => ({}),
  loadRawConfig: () => structuredClone(configStore),
  saveRawConfig: (raw: Record<string, unknown>) => {
    configStore = structuredClone(raw);
  },
  saveConfig: () => {},
  invalidateConfigCache: () => {},
  setNestedValue,
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

// Mock oauth-store (getConnectionByProvider)
let oauthConnectionStore: Record<
  string,
  { id: string; status: string; accountInfo?: string | null }
> = {};

mock.module("../oauth/oauth-store.js", () => ({
  getConnectionByProvider: (provider: string) =>
    oauthConnectionStore[provider] ?? undefined,
  createConnection: () => ({ id: "test-conn-id" }),
  updateConnection: () => true,
  deleteConnection: (id: string) => {
    for (const [key, conn] of Object.entries(oauthConnectionStore)) {
      if (conn.id === id) {
        delete oauthConnectionStore[key];
        return true;
      }
    }
    return false;
  },
  upsertApp: async () => ({ id: "test-app-id" }),
}));

// Mock manual-token-connection
mock.module("../oauth/manual-token-connection.js", () => ({
  ensureManualTokenConnection: async (
    provider: string,
    accountInfo?: string,
  ) => {
    oauthConnectionStore[provider] = {
      id: `conn-${provider}`,
      status: "active",
      accountInfo: accountInfo ?? null,
    };
  },
  removeManualTokenConnection: (provider: string) => {
    delete oauthConnectionStore[provider];
  },
  syncManualTokenConnection: async (provider: string, accountInfo?: string) => {
    const { getSecureKeyAsync } = await import("../security/secure-keys.js");
    if (provider !== "slack_channel") return;
    const hasBotToken = !!(await getSecureKeyAsync(
      credentialKey("slack_channel", "bot_token"),
    ));
    const hasAppToken = !!(await getSecureKeyAsync(
      credentialKey("slack_channel", "app_token"),
    ));
    if (hasBotToken && hasAppToken) {
      oauthConnectionStore[provider] = {
        id: `conn-${provider}`,
        status: "active",
        accountInfo: accountInfo ?? null,
      };
      return;
    }
    delete oauthConnectionStore[provider];
  },
}));

// Mock fetch for Slack API validation
const originalFetch = globalThis.fetch;

import {
  clearSlackChannelConfig,
  getSlackChannelConfig,
  setSlackChannelConfig,
} from "../daemon/handlers/config-slack-channel.js";
import { credentialKey } from "../security/credential-key.js";
import { _setStorePath } from "../security/encrypted-store.js";
import {
  _resetBackend,
  getSecureKeyAsync,
  setSecureKeyAsync,
} from "../security/secure-keys.js";
import {
  _setMetadataPath,
  listCredentialMetadata,
  upsertCredentialMetadata,
} from "../tools/credentials/metadata-store.js";

afterAll(() => {
  globalThis.fetch = originalFetch;
  _setMetadataPath(null);
  _setStorePath(null);
  _resetBackend();
  if (originalVellumDev === undefined) {
    delete process.env.VELLUM_DEV;
  } else {
    process.env.VELLUM_DEV = originalVellumDev;
  }
});

describe("Slack channel config handler", () => {
  beforeEach(() => {
    oauthConnectionStore = {};
    configStore = {};
    globalThis.fetch = originalFetch;
    rmSync(secureStorePath, { force: true });
    rmSync(metadataPath, { force: true });
    _setStorePath(secureStorePath);
    _resetBackend();
    _setMetadataPath(metadataPath);
  });

  test("GET returns correct shape when not configured", async () => {
    const result = await getSlackChannelConfig();
    expect(result.success).toBe(true);
    expect(result.hasBotToken).toBe(false);
    expect(result.hasAppToken).toBe(false);
    expect(result.connected).toBe(false);
  });

  test("GET returns connected: true when oauth_connection is active and both keys exist", async () => {
    oauthConnectionStore["slack_channel"] = {
      id: "conn-slack",
      status: "active",
    };
    await Promise.all([
      setSecureKeyAsync(
        credentialKey("slack_channel", "bot_token"),
        "xoxb-test",
      ),
      setSecureKeyAsync(
        credentialKey("slack_channel", "app_token"),
        "xapp-test",
      ),
    ]);

    const result = await getSlackChannelConfig();
    expect(result.success).toBe(true);
    expect(result.hasBotToken).toBe(true);
    expect(result.hasAppToken).toBe(true);
    expect(result.connected).toBe(true);
  });

  test("GET backfills the slack_channel connection row when chat setup stored both credentials", async () => {
    await Promise.all([
      setSecureKeyAsync(
        credentialKey("slack_channel", "bot_token"),
        "xoxb-test",
      ),
      setSecureKeyAsync(
        credentialKey("slack_channel", "app_token"),
        "xapp-test",
      ),
    ]);

    const result = await getSlackChannelConfig();

    expect(result.success).toBe(true);
    expect(result.connected).toBe(true);
    expect(oauthConnectionStore["slack_channel"]).toBeDefined();
  });

  test("GET reports per-field token presence independently of connection row", async () => {
    // Only bot_token in credential store, no app_token, but connection row exists
    oauthConnectionStore["slack_channel"] = {
      id: "conn-slack",
      status: "active",
    };
    await setSecureKeyAsync(
      credentialKey("slack_channel", "bot_token"),
      "xoxb-test",
    );

    const result = await getSlackChannelConfig();
    expect(result.success).toBe(true);
    expect(result.hasBotToken).toBe(true);
    expect(result.hasAppToken).toBe(false);
    // connected requires both keys AND connection row
    expect(result.connected).toBe(false);
  });

  test("GET returns metadata from config when available", async () => {
    oauthConnectionStore["slack_channel"] = {
      id: "conn-slack",
      status: "active",
    };
    await Promise.all([
      setSecureKeyAsync(
        credentialKey("slack_channel", "bot_token"),
        "xoxb-test",
      ),
      setSecureKeyAsync(
        credentialKey("slack_channel", "app_token"),
        "xapp-test",
      ),
    ]);
    configStore = {
      slack: {
        teamId: "T123",
        teamName: "TestTeam",
        botUserId: "U_BOT",
        botUsername: "testbot",
      },
    };

    const result = await getSlackChannelConfig();
    expect(result.teamId).toBe("T123");
    expect(result.teamName).toBe("TestTeam");
    expect(result.botUserId).toBe("U_BOT");
    expect(result.botUsername).toBe("testbot");
  });

  test("POST validates app token shape (xapp- prefix required)", async () => {
    const result = await setSlackChannelConfig(undefined, "invalid-token");
    expect(result.success).toBe(false);
    expect(result.error).toContain("xapp-");
  });

  test("POST accepts valid app token with xapp- prefix", async () => {
    const result = await setSlackChannelConfig(
      undefined,
      "xapp-valid-token-123",
    );
    expect(result.success).toBe(true);
    expect(result.hasAppToken).toBe(true);
    expect(
      await getSecureKeyAsync(credentialKey("slack_channel", "app_token")),
    ).toBe("xapp-valid-token-123");
  });

  test("POST validates bot token via Slack auth.test API and writes config", async () => {
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          ok: true,
          team_id: "T_TEAM",
          team: "MyTeam",
          user_id: "U_BOT",
          user: "mybot",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as unknown as typeof globalThis.fetch;

    const result = await setSlackChannelConfig("xoxb-valid-bot-token");
    expect(result.success).toBe(true);
    expect(result.hasBotToken).toBe(true);
    expect(result.teamId).toBe("T_TEAM");
    expect(result.teamName).toBe("MyTeam");

    // Assert metadata was written to config (not credential metadata)
    const slack = configStore.slack as Record<string, unknown>;
    expect(slack.teamId).toBe("T_TEAM");
    expect(slack.teamName).toBe("MyTeam");
    expect(slack.botUserId).toBe("U_BOT");
    expect(slack.botUsername).toBe("mybot");
  });

  test("POST returns error when Slack auth.test rejects bot token", async () => {
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          ok: false,
          error: "invalid_auth",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as unknown as typeof globalThis.fetch;

    const result = await setSlackChannelConfig("xoxb-bad-token");
    expect(result.success).toBe(false);
    expect(result.error).toContain("invalid_auth");
  });

  test("DELETE clears credentials and config", async () => {
    await Promise.all([
      setSecureKeyAsync(
        credentialKey("slack_channel", "bot_token"),
        "xoxb-test",
      ),
      setSecureKeyAsync(
        credentialKey("slack_channel", "app_token"),
        "xapp-test",
      ),
    ]);
    upsertCredentialMetadata("slack_channel", "bot_token", {});
    upsertCredentialMetadata("slack_channel", "app_token", {});
    configStore = {
      slack: {
        teamId: "T123",
        teamName: "TestTeam",
        botUserId: "U_BOT",
        botUsername: "testbot",
      },
    };

    const result = await clearSlackChannelConfig();
    expect(result.success).toBe(true);
    expect(result.hasBotToken).toBe(false);
    expect(result.hasAppToken).toBe(false);
    expect(result.connected).toBe(false);

    expect(
      await getSecureKeyAsync(credentialKey("slack_channel", "bot_token")),
    ).toBeUndefined();
    expect(
      await getSecureKeyAsync(credentialKey("slack_channel", "app_token")),
    ).toBeUndefined();
    expect(listCredentialMetadata()).toHaveLength(0);

    // Assert config values were cleared
    const slack = configStore.slack as Record<string, unknown>;
    expect(slack.teamId).toBe("");
    expect(slack.teamName).toBe("");
    expect(slack.botUserId).toBe("");
    expect(slack.botUsername).toBe("");
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = mkdtempSync(join(tmpdir(), "slack-channel-cfg-test-"));

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

mock.module("../util/platform.js", () => ({
  getRootDir: () => testDir,
  getDataDir: () => testDir,

  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
    isDebug: () => false,
    child: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      isDebug: () => false,
    }),
  }),
}));

// Mock secure key storage
let secureKeyStore: Record<string, string> = {};

mock.module("../security/secure-keys.js", () => {
  const syncSet = (account: string, value: string) => {
    secureKeyStore[account] = value;
    return true;
  };
  const syncDelete = (account: string) => {
    if (account in secureKeyStore) {
      delete secureKeyStore[account];
      return "deleted" as const;
    }
    return "not-found" as const;
  };
  return {
    getSecureKey: (account: string) => secureKeyStore[account] ?? undefined,
    setSecureKey: syncSet,
    deleteSecureKey: syncDelete,
    setSecureKeyAsync: async (account: string, value: string) =>
      syncSet(account, value),
    deleteSecureKeyAsync: async (account: string) => syncDelete(account),
    listSecureKeys: () => Object.keys(secureKeyStore),
    getBackendType: () => "encrypted",
    isDowngradedFromKeychain: () => false,
    _resetBackend: () => {},
    _setBackend: () => {},
  };
});

// Mock credential metadata store
let credentialMetadataStore: Array<{
  service: string;
  field: string;
  accountInfo?: string;
}> = [];

mock.module("../tools/credentials/metadata-store.js", () => ({
  getCredentialMetadata: (service: string, field: string) =>
    credentialMetadataStore.find(
      (m) => m.service === service && m.field === field,
    ) ?? undefined,
  upsertCredentialMetadata: (
    service: string,
    field: string,
    policy?: Record<string, unknown>,
  ) => {
    const existing = credentialMetadataStore.find(
      (m) => m.service === service && m.field === field,
    );
    if (existing) {
      if (policy?.accountInfo !== undefined)
        existing.accountInfo = policy.accountInfo as string;
      return existing;
    }
    const record = {
      service,
      field,
      accountInfo: policy?.accountInfo as string | undefined,
    };
    credentialMetadataStore.push(record);
    return record;
  },
  deleteCredentialMetadata: (service: string, field: string) => {
    const idx = credentialMetadataStore.findIndex(
      (m) => m.service === service && m.field === field,
    );
    if (idx !== -1) {
      credentialMetadataStore.splice(idx, 1);
      return true;
    }
    return false;
  },
  listCredentialMetadata: () => credentialMetadataStore,
  assertMetadataWritable: () => {},
  _setMetadataPath: () => {},
}));

// Mock fetch for Slack API validation
const originalFetch = globalThis.fetch;

import {
  clearSlackChannelConfig,
  getSlackChannelConfig,
  setSlackChannelConfig,
} from "../daemon/handlers/config-slack-channel.js";
import { credentialKey } from "../security/credential-key.js";

afterAll(() => {
  globalThis.fetch = originalFetch;
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    /* best effort */
  }
});

describe("Slack channel config handler", () => {
  beforeEach(() => {
    secureKeyStore = {};
    credentialMetadataStore = [];
    configStore = {};
    globalThis.fetch = originalFetch;
  });

  test("GET returns correct shape when not configured", () => {
    const result = getSlackChannelConfig();
    expect(result.success).toBe(true);
    expect(result.hasBotToken).toBe(false);
    expect(result.hasAppToken).toBe(false);
    expect(result.connected).toBe(false);
  });

  test("GET returns connected: true when both tokens are set", () => {
    secureKeyStore[credentialKey("slack_channel", "bot_token")] = "xoxb-test";
    secureKeyStore[credentialKey("slack_channel", "app_token")] = "xapp-test";

    const result = getSlackChannelConfig();
    expect(result.success).toBe(true);
    expect(result.hasBotToken).toBe(true);
    expect(result.hasAppToken).toBe(true);
    expect(result.connected).toBe(true);
  });

  test("GET returns metadata from config when available", () => {
    secureKeyStore[credentialKey("slack_channel", "bot_token")] = "xoxb-test";
    configStore = {
      slack: {
        teamId: "T123",
        teamName: "TestTeam",
        botUserId: "U_BOT",
        botUsername: "testbot",
      },
    };

    const result = getSlackChannelConfig();
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
    expect(secureKeyStore[credentialKey("slack_channel", "app_token")]).toBe(
      "xapp-valid-token-123",
    );
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
    secureKeyStore[credentialKey("slack_channel", "bot_token")] = "xoxb-test";
    secureKeyStore[credentialKey("slack_channel", "app_token")] = "xapp-test";
    credentialMetadataStore.push({
      service: "slack_channel",
      field: "bot_token",
    });
    credentialMetadataStore.push({
      service: "slack_channel",
      field: "app_token",
    });
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
      secureKeyStore[credentialKey("slack_channel", "bot_token")],
    ).toBeUndefined();
    expect(
      secureKeyStore[credentialKey("slack_channel", "app_token")],
    ).toBeUndefined();
    expect(credentialMetadataStore).toHaveLength(0);

    // Assert config values were cleared
    const slack = configStore.slack as Record<string, unknown>;
    expect(slack.teamId).toBe("");
    expect(slack.teamName).toBe("");
    expect(slack.botUserId).toBe("");
    expect(slack.botUsername).toBe("");
  });
});

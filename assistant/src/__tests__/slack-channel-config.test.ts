import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

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
  backfillSlackInjectionTemplates,
  clearSlackChannelConfig,
  clearSlackUserToken,
  getSlackChannelConfig,
  setSlackChannelConfig,
} from "../daemon/handlers/config-slack-channel.js";
import { credentialKey } from "../security/credential-key.js";
import { _setStorePath } from "../security/encrypted-store.js";
import * as secureKeys from "../security/secure-keys.js";
import {
  _resetBackend,
  getSecureKeyAsync,
  setSecureKeyAsync,
} from "../security/secure-keys.js";
import {
  _setMetadataPath,
  getCredentialMetadata,
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

  test("POST accepts valid user token and stores injection templates", async () => {
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          ok: true,
          team_id: "T_TEAM",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as unknown as typeof globalThis.fetch;

    const result = await setSlackChannelConfig(
      undefined,
      undefined,
      "xoxp-valid-user-token",
    );
    expect(result.success).toBe(true);
    expect(result.hasUserToken).toBe(true);
    expect(
      await getSecureKeyAsync(credentialKey("slack_channel", "user_token")),
    ).toBe("xoxp-valid-user-token");

    // Metadata has injection templates for the user token.
    const meta = getCredentialMetadata("slack_channel", "user_token");
    expect(meta).toBeDefined();
    expect(meta?.allowedDomains).toEqual(["slack.com"]);
    expect(meta?.injectionTemplates).toBeDefined();
    expect(meta?.injectionTemplates?.length ?? 0).toBeGreaterThan(0);
    expect(meta?.injectionTemplates?.[0].hostPattern).toBe("*.slack.com");
    expect(meta?.injectionTemplates?.[0].headerName).toBe("Authorization");
  });

  test("POST rejects user token with invalid prefix", async () => {
    const result = await setSlackChannelConfig(undefined, undefined, "abc-123");
    expect(result.success).toBe(false);
    expect(result.error).toContain("xoxp-");
    // Nothing was stored.
    expect(
      await getSecureKeyAsync(credentialKey("slack_channel", "user_token")),
    ).toBeUndefined();
  });

  test("POST drops stale user_token when bot_token workspace differs", async () => {
    // Scenario: user provisionally stores a user_token for workspace A before
    // any bot token exists. Later they store a bot_token for workspace B.
    // The handler must clear the stale user_token so reads (user_token) and
    // writes (bot_token) never span workspaces.
    await setSecureKeyAsync(
      credentialKey("slack_channel", "user_token"),
      "xoxp-workspace-a",
    );
    upsertCredentialMetadata("slack_channel", "user_token", {});
    // No bot token yet — config has no teamId.

    // fetch is called twice: once to validate the new bot_token (workspace B),
    // once to auth.test the persisted user_token (workspace A).
    const calls: string[] = [];
    globalThis.fetch = (async (
      _url: string,
      init?: { headers?: Record<string, string> },
    ) => {
      const auth = init?.headers?.["Authorization"] ?? "";
      calls.push(auth);
      if (auth === "Bearer xoxb-workspace-b") {
        return new Response(
          JSON.stringify({
            ok: true,
            team_id: "T_B",
            team: "TeamB",
            user_id: "U_BOT_B",
            user: "botb",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (auth === "Bearer xoxp-workspace-a") {
        return new Response(
          JSON.stringify({
            ok: true,
            team_id: "T_A",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected auth header: ${auth}`);
    }) as unknown as typeof globalThis.fetch;

    const result = await setSlackChannelConfig("xoxb-workspace-b");

    expect(result.success).toBe(true);
    expect(result.hasBotToken).toBe(true);
    expect(result.hasUserToken).toBe(false);
    expect(result.teamId).toBe("T_B");
    expect(result.warning).toBeDefined();
    expect(result.warning).toContain("different workspace");

    // user_token secure key + metadata are gone.
    expect(
      await getSecureKeyAsync(credentialKey("slack_channel", "user_token")),
    ).toBeUndefined();
    expect(
      getCredentialMetadata("slack_channel", "user_token"),
    ).toBeUndefined();

    // Both fetches happened: bot validation and user_token cross-check.
    expect(calls).toContain("Bearer xoxb-workspace-b");
    expect(calls).toContain("Bearer xoxp-workspace-a");
  });

  test("POST keeps user_token when bot_token workspace matches", async () => {
    // Same workspace as persisted user_token — keep it.
    await setSecureKeyAsync(
      credentialKey("slack_channel", "user_token"),
      "xoxp-workspace-a",
    );
    upsertCredentialMetadata("slack_channel", "user_token", {});

    globalThis.fetch = (async (
      _url: string,
      init?: { headers?: Record<string, string> },
    ) => {
      const auth = init?.headers?.["Authorization"] ?? "";
      if (auth === "Bearer xoxb-workspace-a") {
        return new Response(
          JSON.stringify({
            ok: true,
            team_id: "T_A",
            team: "TeamA",
            user_id: "U_BOT_A",
            user: "bota",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (auth === "Bearer xoxp-workspace-a") {
        return new Response(
          JSON.stringify({
            ok: true,
            team_id: "T_A",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected auth header: ${auth}`);
    }) as unknown as typeof globalThis.fetch;

    const result = await setSlackChannelConfig("xoxb-workspace-a");

    expect(result.success).toBe(true);
    expect(result.hasBotToken).toBe(true);
    expect(result.hasUserToken).toBe(true);
    expect(result.teamId).toBe("T_A");
    // No cross-workspace warning — both tokens match.
    expect(result.warning ?? "").not.toContain("different workspace");

    expect(
      await getSecureKeyAsync(credentialKey("slack_channel", "user_token")),
    ).toBe("xoxp-workspace-a");
  });

  test("POST drops user_token whose auth.test now fails when bot_token is stored", async () => {
    await setSecureKeyAsync(
      credentialKey("slack_channel", "user_token"),
      "xoxp-revoked",
    );
    upsertCredentialMetadata("slack_channel", "user_token", {});

    globalThis.fetch = (async (
      _url: string,
      init?: { headers?: Record<string, string> },
    ) => {
      const auth = init?.headers?.["Authorization"] ?? "";
      if (auth === "Bearer xoxb-workspace-a") {
        return new Response(
          JSON.stringify({
            ok: true,
            team_id: "T_A",
            team: "TeamA",
            user_id: "U_BOT_A",
            user: "bota",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (auth === "Bearer xoxp-revoked") {
        return new Response(
          JSON.stringify({ ok: false, error: "token_revoked" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected auth header: ${auth}`);
    }) as unknown as typeof globalThis.fetch;

    const result = await setSlackChannelConfig("xoxb-workspace-a");

    expect(result.success).toBe(true);
    expect(result.hasBotToken).toBe(true);
    expect(result.hasUserToken).toBe(false);
    expect(result.warning).toBeDefined();
    expect(result.warning).toContain("User token");

    expect(
      await getSecureKeyAsync(credentialKey("slack_channel", "user_token")),
    ).toBeUndefined();
  });

  test("POST preserves user_token when its auth.test throws a transient network error", async () => {
    // Regression guard: a network blip during user_token re-validation must
    // not wipe a still-valid user_token. The adapter tolerates stale tokens —
    // they surface on next real use, not on every bot_token update.
    await setSecureKeyAsync(
      credentialKey("slack_channel", "user_token"),
      "xoxp-still-valid",
    );
    upsertCredentialMetadata("slack_channel", "user_token", {});

    globalThis.fetch = (async (
      _url: string,
      init?: { headers?: Record<string, string> },
    ) => {
      const auth = init?.headers?.["Authorization"] ?? "";
      if (auth === "Bearer xoxb-workspace-a") {
        return new Response(
          JSON.stringify({
            ok: true,
            team_id: "T_A",
            team: "TeamA",
            user_id: "U_BOT_A",
            user: "bota",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (auth === "Bearer xoxp-still-valid") {
        throw new Error("network down");
      }
      throw new Error(`Unexpected auth header: ${auth}`);
    }) as unknown as typeof globalThis.fetch;

    const result = await setSlackChannelConfig("xoxb-workspace-a");

    // Bot token stored successfully.
    expect(result.success).toBe(true);
    expect(result.hasBotToken).toBe(true);
    expect(result.teamId).toBe("T_A");

    // User token is UNTOUCHED — transient errors are not a reason to delete.
    expect(result.hasUserToken).toBe(true);
    expect(
      await getSecureKeyAsync(credentialKey("slack_channel", "user_token")),
    ).toBe("xoxp-still-valid");
    expect(getCredentialMetadata("slack_channel", "user_token")).toBeDefined();

    // No warning about user_token removal — nothing was removed.
    expect(result.warning ?? "").not.toContain("User token");
  });

  test("POST surfaces delete failure when cross-workspace clear cannot remove user_token", async () => {
    // Regression guard: if deleteSecureKeyAsync returns "error" during the
    // cross-workspace cleanup, the handler must report the failure (not
    // silently claim success) and must not claim the token was removed.
    await setSecureKeyAsync(
      credentialKey("slack_channel", "user_token"),
      "xoxp-workspace-a",
    );
    upsertCredentialMetadata("slack_channel", "user_token", {});

    globalThis.fetch = (async (
      _url: string,
      init?: { headers?: Record<string, string> },
    ) => {
      const auth = init?.headers?.["Authorization"] ?? "";
      if (auth === "Bearer xoxb-workspace-b") {
        return new Response(
          JSON.stringify({
            ok: true,
            team_id: "T_B",
            team: "TeamB",
            user_id: "U_BOT_B",
            user: "botb",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (auth === "Bearer xoxp-workspace-a") {
        // Workspace mismatch — handler will try to clear the user_token.
        return new Response(JSON.stringify({ ok: true, team_id: "T_A" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected auth header: ${auth}`);
    }) as unknown as typeof globalThis.fetch;

    // Force the user_token delete to fail. Other callers (e.g. bot_token
    // store during setSecureKeyAsync flow) are not delete calls so they are
    // unaffected; clearSlackChannelConfig's later deletes would be, but this
    // test only exercises setSlackChannelConfig.
    const userTokenKey = credentialKey("slack_channel", "user_token");
    const deleteSpy = spyOn(secureKeys, "deleteSecureKeyAsync");
    deleteSpy.mockImplementation(async (account: string) => {
      if (account === userTokenKey) return "error";
      // Fall through to real implementation would require the original ref;
      // this test only triggers deletion of the user_token, so returning
      // "not-found" for any other key is safe (none are asserted on).
      return "not-found";
    });

    try {
      const result = await setSlackChannelConfig("xoxb-workspace-b");

      // Bot token store still succeeds.
      expect(result.success).toBe(true);
      expect(result.hasBotToken).toBe(true);
      expect(result.teamId).toBe("T_B");

      // Delete failed -> user_token is still in the store.
      expect(
        await getSecureKeyAsync(credentialKey("slack_channel", "user_token")),
      ).toBe("xoxp-workspace-a");
      expect(result.hasUserToken).toBe(true);

      // Warning must mention the removal failure and NOT claim removal
      // succeeded.
      expect(result.warning).toBeDefined();
      expect(result.warning).toContain("removal failed");
      expect(result.warning).not.toContain("was removed");
    } finally {
      deleteSpy.mockRestore();
    }
  });

  test("POST rejects user token from a different workspace than the bot token", async () => {
    // Pre-seed config with bot-token-derived team id (T_TEAM) to simulate that
    // a bot token has already been configured.
    configStore = {
      slack: {
        teamId: "T_TEAM",
        teamName: "TestTeam",
        botUserId: "U_BOT",
        botUsername: "testbot",
      },
    };

    globalThis.fetch = (async () => {
      // User token's auth.test returns a different team_id.
      return new Response(
        JSON.stringify({
          ok: true,
          team_id: "T_OTHER",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as unknown as typeof globalThis.fetch;

    const result = await setSlackChannelConfig(
      undefined,
      undefined,
      "xoxp-other-workspace",
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("different workspace");
    // Token was not stored.
    expect(
      await getSecureKeyAsync(credentialKey("slack_channel", "user_token")),
    ).toBeUndefined();
  });

  test("DELETE clears user token key and metadata", async () => {
    await Promise.all([
      setSecureKeyAsync(
        credentialKey("slack_channel", "bot_token"),
        "xoxb-test",
      ),
      setSecureKeyAsync(
        credentialKey("slack_channel", "app_token"),
        "xapp-test",
      ),
      setSecureKeyAsync(
        credentialKey("slack_channel", "user_token"),
        "xoxp-test",
      ),
    ]);
    upsertCredentialMetadata("slack_channel", "bot_token", {});
    upsertCredentialMetadata("slack_channel", "app_token", {});
    upsertCredentialMetadata("slack_channel", "user_token", {});

    const result = await clearSlackChannelConfig();
    expect(result.success).toBe(true);
    expect(result.hasUserToken).toBe(false);

    expect(
      await getSecureKeyAsync(credentialKey("slack_channel", "user_token")),
    ).toBeUndefined();
    expect(
      getCredentialMetadata("slack_channel", "user_token"),
    ).toBeUndefined();
  });

  test("clearSlackUserToken leaves bot+app tokens and oauth_connection intact", async () => {
    // Seed all three tokens + metadata + an active oauth_connection row.
    await Promise.all([
      setSecureKeyAsync(
        credentialKey("slack_channel", "bot_token"),
        "xoxb-test",
      ),
      setSecureKeyAsync(
        credentialKey("slack_channel", "app_token"),
        "xapp-test",
      ),
      setSecureKeyAsync(
        credentialKey("slack_channel", "user_token"),
        "xoxp-test",
      ),
    ]);
    upsertCredentialMetadata("slack_channel", "bot_token", {});
    upsertCredentialMetadata("slack_channel", "app_token", {});
    upsertCredentialMetadata("slack_channel", "user_token", {});
    oauthConnectionStore["slack_channel"] = {
      id: "conn-slack",
      status: "active",
    };

    const result = await clearSlackUserToken();

    expect(result.success).toBe(true);
    expect(result.hasUserToken).toBe(false);
    expect(result.hasBotToken).toBe(true);
    expect(result.hasAppToken).toBe(true);
    expect(result.connected).toBe(true);

    // user_token key + metadata gone.
    expect(
      await getSecureKeyAsync(credentialKey("slack_channel", "user_token")),
    ).toBeUndefined();
    expect(
      getCredentialMetadata("slack_channel", "user_token"),
    ).toBeUndefined();

    // bot + app tokens + their metadata still present.
    expect(
      await getSecureKeyAsync(credentialKey("slack_channel", "bot_token")),
    ).toBe("xoxb-test");
    expect(
      await getSecureKeyAsync(credentialKey("slack_channel", "app_token")),
    ).toBe("xapp-test");
    expect(getCredentialMetadata("slack_channel", "bot_token")).toBeDefined();
    expect(getCredentialMetadata("slack_channel", "app_token")).toBeDefined();

    // oauth_connection row was not touched.
    expect(oauthConnectionStore["slack_channel"]).toBeDefined();
    expect(oauthConnectionStore["slack_channel"].status).toBe("active");

    // GET reports the right state after the surgical delete.
    const after = await getSlackChannelConfig();
    expect(after.connected).toBe(true);
    expect(after.hasBotToken).toBe(true);
    expect(after.hasAppToken).toBe(true);
    expect(after.hasUserToken).toBe(false);
  });

  test("clearSlackUserToken reports failure when user_token is already absent", async () => {
    // Seed bot+app tokens but no user_token.
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
    oauthConnectionStore["slack_channel"] = {
      id: "conn-slack",
      status: "active",
    };

    const result = await clearSlackUserToken();

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);
    expect(result.hasBotToken).toBe(true);
    expect(result.hasAppToken).toBe(true);
    expect(result.hasUserToken).toBe(false);
    // bot+app tokens and oauth_connection remain intact.
    expect(oauthConnectionStore["slack_channel"]).toBeDefined();
    expect(oauthConnectionStore["slack_channel"].status).toBe("active");
  });

  test("GET reports hasUserToken: false when only bot+app tokens present", async () => {
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
    expect(result.hasUserToken).toBe(false);
    expect(result.connected).toBe(true);
  });

  test("GET reports hasUserToken: true when all three tokens are present", async () => {
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
      setSecureKeyAsync(
        credentialKey("slack_channel", "user_token"),
        "xoxp-test",
      ),
    ]);

    const result = await getSlackChannelConfig();
    expect(result.success).toBe(true);
    expect(result.hasBotToken).toBe(true);
    expect(result.hasAppToken).toBe(true);
    expect(result.hasUserToken).toBe(true);
    expect(result.connected).toBe(true);
  });

  test("backfill upgrades stale slack.com exact-match injection templates to the wildcard form", async () => {
    // Simulate an existing install that stored credentials before the
    // wildcard migration: bot + user tokens carry the legacy hostPattern,
    // which left files.slack.com downloads unauthenticated by the
    // outbound proxy.
    await Promise.all([
      setSecureKeyAsync(
        credentialKey("slack_channel", "bot_token"),
        "xoxb-legacy",
      ),
      setSecureKeyAsync(
        credentialKey("slack_channel", "user_token"),
        "xoxp-legacy",
      ),
    ]);
    upsertCredentialMetadata("slack_channel", "bot_token", {
      allowedDomains: ["slack.com"],
      injectionTemplates: [
        {
          hostPattern: "slack.com",
          injectionType: "header",
          headerName: "Authorization",
          valuePrefix: "Bearer ",
        },
      ],
    });
    upsertCredentialMetadata("slack_channel", "user_token", {
      allowedDomains: ["slack.com"],
      injectionTemplates: [
        {
          hostPattern: "slack.com",
          injectionType: "header",
          headerName: "Authorization",
          valuePrefix: "Bearer ",
        },
      ],
    });

    backfillSlackInjectionTemplates();

    for (const field of ["bot_token", "user_token"] as const) {
      const meta = getCredentialMetadata("slack_channel", field);
      expect(meta?.allowedDomains).toEqual(["slack.com"]);
      expect(meta?.injectionTemplates?.[0].hostPattern).toBe("*.slack.com");
    }
  });

  test("backfill leaves already-migrated injection templates untouched", async () => {
    await setSecureKeyAsync(
      credentialKey("slack_channel", "bot_token"),
      "xoxb-current",
    );
    upsertCredentialMetadata("slack_channel", "bot_token", {
      allowedDomains: ["slack.com"],
      injectionTemplates: [
        {
          hostPattern: "*.slack.com",
          injectionType: "header",
          headerName: "Authorization",
          valuePrefix: "Bearer ",
        },
      ],
    });
    const before = getCredentialMetadata("slack_channel", "bot_token");
    const beforeUpdatedAt = before?.updatedAt;

    backfillSlackInjectionTemplates();

    const after = getCredentialMetadata("slack_channel", "bot_token");
    expect(after?.updatedAt).toBe(beforeUpdatedAt);
    expect(after?.allowedDomains).toEqual(["slack.com"]);
    expect(after?.injectionTemplates?.[0].hostPattern).toBe("*.slack.com");
  });
});

import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

const originalVellumDev = process.env.VELLUM_DEV;
process.env.VELLUM_DEV = "1";

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

let oauthConnectionStore: Record<string, { id: string; status: string }> = {};

mock.module("../oauth/manual-token-connection.js", () => ({
  ensureManualTokenConnection: async (provider: string) => {
    oauthConnectionStore[provider] = {
      id: `conn-${provider}`,
      status: "active",
    };
  },
  removeManualTokenConnection: (provider: string) => {
    delete oauthConnectionStore[provider];
  },
  syncManualTokenConnection: async () => {},
}));

const originalFetch = globalThis.fetch;

import {
  clearDiscordChannelConfig,
  getDiscordChannelConfig,
  setDiscordChannelConfig,
} from "../daemon/handlers/config-discord-channel.js";
import { credentialKey } from "../security/credential-key.js";
import * as secureKeys from "../security/secure-keys.js";
import { _resetBackend, getSecureKeyAsync } from "../security/secure-keys.js";
import { _setMetadataPath } from "../tools/credentials/metadata-store.js";
import { setStorePathForTesting } from "./encrypted-store-test-helpers.js";
import { setConfig } from "./helpers/set-config.js";

const BOT_TOKEN_KEY = credentialKey("discord_channel", "bot_token");

/**
 * The permission integer the parameterized invite link requests. The setup
 * skill's invite script derives the same value from named bits; skills are
 * import-isolated from this package, so equality is pinned here instead.
 */
const INVITE_PERMISSIONS = "277025770560";

interface FakeDiscord {
  meStatus?: number;
  application?: unknown;
}

function installDiscordApi(fake: FakeDiscord) {
  globalThis.fetch = (async (input: URL | RequestInfo) => {
    const url = String(input);
    if (url.endsWith("/users/@me")) {
      return new Response(
        JSON.stringify({ id: "900000000000000001", username: "test-bot" }),
        { status: fake.meStatus ?? 200 },
      );
    }
    if (url.endsWith("/oauth2/applications/@me")) {
      return new Response(JSON.stringify(fake.application ?? {}), {
        status: 200,
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
}

afterAll(() => {
  globalThis.fetch = originalFetch;
  _setMetadataPath(null);
  setStorePathForTesting(null);
  _resetBackend();
  if (originalVellumDev === undefined) {
    delete process.env.VELLUM_DEV;
  } else {
    process.env.VELLUM_DEV = originalVellumDev;
  }
});

const testDir = process.env.VELLUM_WORKSPACE_DIR!;
const secureStorePath = join(testDir, "discord-config-keys.enc");
const metadataPath = join(testDir, "discord-config-metadata.json");

beforeEach(() => {
  oauthConnectionStore = {};
  setConfig("discord", {});
  rmSync(secureStorePath, { force: true });
  rmSync(metadataPath, { force: true });
  setStorePathForTesting(secureStorePath);
  _resetBackend();
  _setMetadataPath(metadataPath);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("connecting a Discord bot", () => {
  test("a valid token is stored and the identity read back", async () => {
    installDiscordApi({
      application: { id: "700000000000000001" },
    });

    const result = await setDiscordChannelConfig("bot-valid-token");

    expect(result.success).toBe(true);
    expect(result.connected).toBe(true);
    expect(result.botUserId).toBe("900000000000000001");
    expect(result.botUsername).toBe("test-bot");
    expect(result.applicationId).toBe("700000000000000001");
    expect(await getSecureKeyAsync(BOT_TOKEN_KEY)).toBe("bot-valid-token");

    const read = await getDiscordChannelConfig();
    expect(read.hasBotToken).toBe(true);
    expect(read.botUsername).toBe("test-bot");
  });

  test("an app without install settings gets a parameterized invite link", async () => {
    // The wizard's create step makes exactly this app: a client-id-only link
    // would install nothing, so the link has to say what to grant.
    installDiscordApi({ application: { id: "700000000000000001" } });

    const result = await setDiscordChannelConfig("bot-valid-token");

    const url = new URL(result.inviteUrl!);
    expect(url.searchParams.get("client_id")).toBe("700000000000000001");
    expect(url.searchParams.get("scope")).toBe("bot");
    expect(url.searchParams.get("permissions")).toBe(INVITE_PERMISSIONS);
  });

  test("an app whose install settings grant bot gets a client-id-only link", async () => {
    // The owner's Default Install Settings own the grant; parameters in the
    // URL would silently override what they configured.
    installDiscordApi({
      application: {
        id: "700000000000000001",
        integration_types_config: {
          "0": { oauth2_install_params: { scopes: ["bot"] } },
        },
      },
    });

    const result = await setDiscordChannelConfig("bot-valid-token");

    const url = new URL(result.inviteUrl!);
    expect(url.searchParams.get("client_id")).toBe("700000000000000001");
    expect(url.searchParams.get("scope")).toBeNull();
    expect(url.searchParams.get("permissions")).toBeNull();

    // And the link survives a reload through the stored config.
    const read = await getDiscordChannelConfig();
    expect(read.inviteUrl).toBe(result.inviteUrl);
  });

  test("a rejected token stores nothing", async () => {
    installDiscordApi({ meStatus: 401 });

    const result = await setDiscordChannelConfig("bot-bad-token");

    expect(result.success).toBe(false);
    expect(result.hasBotToken).toBe(false);
    expect(result.error).toContain("rejected");
    expect(await getSecureKeyAsync(BOT_TOKEN_KEY)).toBeFalsy();
  });
});

describe("disconnecting a Discord bot", () => {
  test("clearing removes the token and the stored identity", async () => {
    installDiscordApi({ application: { id: "700000000000000001" } });
    await setDiscordChannelConfig("bot-valid-token");

    const result = await clearDiscordChannelConfig();

    expect(result.success).toBe(true);
    expect(result.hasBotToken).toBe(false);
    expect(result.connected).toBe(false);
    expect(await getSecureKeyAsync(BOT_TOKEN_KEY)).toBeFalsy();
    const read = await getDiscordChannelConfig();
    expect(read.botUsername).toBeUndefined();
    expect(read.inviteUrl).toBeUndefined();
  });

  test("a failed credential delete does not report a disconnect", async () => {
    installDiscordApi({ application: { id: "700000000000000001" } });
    await setDiscordChannelConfig("bot-valid-token");

    const deleteSpy = spyOn(
      secureKeys,
      "deleteSecureKeyAsync",
    ).mockResolvedValue("error");
    try {
      const result = await clearDiscordChannelConfig();
      // The token is still stored, so the gateway's client stays connected: a
      // success here would be a disconnect that did not happen.
      expect(result.success).toBe(false);
      expect(result.hasBotToken).toBe(true);
      expect(result.connected).toBe(true);
    } finally {
      deleteSpy.mockRestore();
    }
    expect(await getSecureKeyAsync(BOT_TOKEN_KEY)).toBe("bot-valid-token");
  });

  test("clearing when nothing is stored is already disconnected", async () => {
    const result = await clearDiscordChannelConfig();

    expect(result.success).toBe(true);
    expect(result.hasBotToken).toBe(false);
  });
});

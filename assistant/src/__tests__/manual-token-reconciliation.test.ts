import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { SecureKeyResult } from "../security/secure-keys.js";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let secureKeyResults: Record<string, SecureKeyResult> = {};
let connectionStore: Record<
  string,
  { id: string; provider: string; accountInfo?: string | null }
> = {};
let deletedConnectionIds: string[] = [];
let createdConnections: Array<{ provider: string; accountInfo?: string }> = [];
const warnings: string[] = [];

// ---------------------------------------------------------------------------
// Module mocks — must be registered before importing the module under test
// ---------------------------------------------------------------------------

mock.module("../util/logger.js", () => ({
  getLogger: () => ({
    warn: (msg: string) => warnings.push(msg),
    info: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

mock.module("../security/secure-keys.js", () => ({
  getSecureKeyResultAsync: async (account: string): Promise<SecureKeyResult> =>
    secureKeyResults[account] ?? { value: undefined, unreachable: false },
  // Keep getSecureKeyAsync available for any transitive imports
  getSecureKeyAsync: async (account: string): Promise<string | undefined> => {
    const result = secureKeyResults[account] ?? {
      value: undefined,
      unreachable: false,
    };
    return result.value;
  },
}));

mock.module("../oauth/oauth-store.js", () => ({
  getConnectionByProvider: (provider: string) =>
    connectionStore[provider] ?? undefined,
  deleteConnection: (id: string) => {
    deletedConnectionIds.push(id);
    // Remove from store
    for (const [key, val] of Object.entries(connectionStore)) {
      if (val.id === id) {
        delete connectionStore[key];
        break;
      }
    }
  },
  createConnection: (params: {
    oauthAppId: string;
    provider: string;
    accountInfo?: string;
    grantedScopes: string[];
    hasRefreshToken: boolean;
  }) => {
    createdConnections.push({
      provider: params.provider,
      accountInfo: params.accountInfo,
    });
    connectionStore[params.provider] = {
      id: `conn-${params.provider}`,
      provider: params.provider,
      accountInfo: params.accountInfo ?? null,
    };
    return { id: `conn-${params.provider}` };
  },
  updateConnection: () => {},
  upsertApp: async (_provider: string, _clientId: string) => ({
    id: "app-1",
  }),
}));

// ---------------------------------------------------------------------------
// Import module under test (after mocks are registered)
// ---------------------------------------------------------------------------

const { backfillManualTokenConnections, syncManualTokenConnection } =
  await import("../oauth/manual-token-connection.js");
import { credentialKey } from "../security/credential-key.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setCredentialResult(
  service: string,
  field: string,
  result: SecureKeyResult,
): void {
  secureKeyResults[credentialKey(service, field)] = result;
}

function seedConnection(
  provider: string,
  opts?: { accountInfo?: string },
): void {
  connectionStore[provider] = {
    id: `conn-${provider}`,
    provider,
    accountInfo: opts?.accountInfo ?? null,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("syncManualTokenConnection", () => {
  beforeEach(() => {
    secureKeyResults = {};
    connectionStore = {};
    deletedConnectionIds = [];
    createdConnections = [];
    warnings.length = 0;
  });

  // ---- Slack: reachable backend, missing tokens -> removes row ----

  test("removes slack_channel connection when bot token is missing and backend is reachable", async () => {
    seedConnection("slack_channel");
    setCredentialResult("slack_channel", "bot_token", {
      value: undefined,
      unreachable: false,
    });
    setCredentialResult("slack_channel", "app_token", {
      value: "xapp-valid",
      unreachable: false,
    });

    await syncManualTokenConnection("slack_channel");

    expect(deletedConnectionIds).toContain("conn-slack_channel");
    expect(connectionStore["slack_channel"]).toBeUndefined();
  });

  test("removes slack_channel connection when app token is missing and backend is reachable", async () => {
    seedConnection("slack_channel");
    setCredentialResult("slack_channel", "bot_token", {
      value: "xoxb-valid",
      unreachable: false,
    });
    setCredentialResult("slack_channel", "app_token", {
      value: undefined,
      unreachable: false,
    });

    await syncManualTokenConnection("slack_channel");

    expect(deletedConnectionIds).toContain("conn-slack_channel");
    expect(connectionStore["slack_channel"]).toBeUndefined();
  });

  // ---- Telegram: reachable backend, missing tokens -> removes row ----

  test("removes telegram connection when bot token is missing and backend is reachable", async () => {
    seedConnection("telegram");
    setCredentialResult("telegram", "bot_token", {
      value: undefined,
      unreachable: false,
    });
    setCredentialResult("telegram", "webhook_secret", {
      value: "secret-valid",
      unreachable: false,
    });

    await syncManualTokenConnection("telegram");

    expect(deletedConnectionIds).toContain("conn-telegram");
    expect(connectionStore["telegram"]).toBeUndefined();
  });

  test("removes telegram connection when webhook secret is missing and backend is reachable", async () => {
    seedConnection("telegram");
    setCredentialResult("telegram", "bot_token", {
      value: "bot-token-valid",
      unreachable: false,
    });
    setCredentialResult("telegram", "webhook_secret", {
      value: undefined,
      unreachable: false,
    });

    await syncManualTokenConnection("telegram");

    expect(deletedConnectionIds).toContain("conn-telegram");
    expect(connectionStore["telegram"]).toBeUndefined();
  });

  // ---- Unreachable backend -> leaves rows untouched ----

  test("leaves slack_channel connection untouched when backend is unreachable", async () => {
    seedConnection("slack_channel");
    setCredentialResult("slack_channel", "bot_token", {
      value: undefined,
      unreachable: true,
    });
    setCredentialResult("slack_channel", "app_token", {
      value: undefined,
      unreachable: true,
    });

    await syncManualTokenConnection("slack_channel");

    expect(deletedConnectionIds).toEqual([]);
    expect(createdConnections).toEqual([]);
    expect(connectionStore["slack_channel"]).toBeDefined();
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("slack_channel");
    expect(warnings[0]).toContain("unreachable");
  });

  test("leaves telegram connection untouched when backend is unreachable", async () => {
    seedConnection("telegram");
    setCredentialResult("telegram", "bot_token", {
      value: undefined,
      unreachable: true,
    });
    setCredentialResult("telegram", "webhook_secret", {
      value: undefined,
      unreachable: true,
    });

    await syncManualTokenConnection("telegram");

    expect(deletedConnectionIds).toEqual([]);
    expect(createdConnections).toEqual([]);
    expect(connectionStore["telegram"]).toBeDefined();
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("telegram");
    expect(warnings[0]).toContain("unreachable");
  });

  test("leaves slack_channel connection untouched when only one credential read is unreachable", async () => {
    seedConnection("slack_channel");
    // bot_token is readable but app_token backend is unreachable
    setCredentialResult("slack_channel", "bot_token", {
      value: "xoxb-valid",
      unreachable: false,
    });
    setCredentialResult("slack_channel", "app_token", {
      value: undefined,
      unreachable: true,
    });

    await syncManualTokenConnection("slack_channel");

    expect(deletedConnectionIds).toEqual([]);
    expect(connectionStore["slack_channel"]).toBeDefined();
  });

  // ---- Reachable backend, all tokens present -> ensures connection ----

  test("creates slack_channel connection when all tokens are present", async () => {
    setCredentialResult("slack_channel", "bot_token", {
      value: "xoxb-valid",
      unreachable: false,
    });
    setCredentialResult("slack_channel", "app_token", {
      value: "xapp-valid",
      unreachable: false,
    });

    await syncManualTokenConnection("slack_channel");

    expect(createdConnections).toEqual([
      { provider: "slack_channel", accountInfo: undefined },
    ]);
  });

  test("creates telegram connection when all tokens are present", async () => {
    setCredentialResult("telegram", "bot_token", {
      value: "bot-token",
      unreachable: false,
    });
    setCredentialResult("telegram", "webhook_secret", {
      value: "webhook-secret",
      unreachable: false,
    });

    await syncManualTokenConnection("telegram");

    expect(createdConnections).toEqual([
      { provider: "telegram", accountInfo: undefined },
    ]);
  });
});

describe("backfillManualTokenConnections", () => {
  beforeEach(() => {
    secureKeyResults = {};
    connectionStore = {};
    deletedConnectionIds = [];
    createdConnections = [];
    warnings.length = 0;
  });

  test("propagates non-destructive behavior — unreachable backend leaves all rows untouched", async () => {
    seedConnection("telegram");
    seedConnection("slack_channel");

    // All credential reads return unreachable
    setCredentialResult("telegram", "bot_token", {
      value: undefined,
      unreachable: true,
    });
    setCredentialResult("telegram", "webhook_secret", {
      value: undefined,
      unreachable: true,
    });
    setCredentialResult("slack_channel", "bot_token", {
      value: undefined,
      unreachable: true,
    });
    setCredentialResult("slack_channel", "app_token", {
      value: undefined,
      unreachable: true,
    });

    await backfillManualTokenConnections();

    expect(deletedConnectionIds).toEqual([]);
    expect(connectionStore["telegram"]).toBeDefined();
    expect(connectionStore["slack_channel"]).toBeDefined();
    expect(warnings.length).toBe(2);
  });
});

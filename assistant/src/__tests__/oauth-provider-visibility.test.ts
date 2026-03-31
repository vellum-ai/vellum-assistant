import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../security/secure-keys.js", () => ({
  deleteSecureKeyAsync: () => Promise.resolve("deleted" as const),
  setSecureKeyAsync: () => Promise.resolve(true),
  getSecureKeyAsync: () => Promise.resolve(undefined),
}));

import { _setOverridesForTesting } from "../config/assistant-feature-flags.js";
import type { AssistantConfig } from "../config/schema.js";
import { initializeDb, resetDb, resetTestTables } from "../memory/db.js";
import { listProviders, seedProviders } from "../oauth/oauth-store.js";
import { isProviderVisible } from "../oauth/provider-visibility.js";

initializeDb();

/** Create a minimal AssistantConfig for testing. */
function makeConfig(): AssistantConfig {
  return {} as AssistantConfig;
}

beforeEach(() => {
  resetTestTables("oauth_connections", "oauth_apps", "oauth_providers");
  _setOverridesForTesting({});
});

afterEach(() => {
  _setOverridesForTesting({});
});

afterAll(() => {
  resetDb();
});

describe("isProviderVisible", () => {
  test("returns true when featureFlag is null", () => {
    seedProviders([
      {
        providerKey: "no-flag-provider",
        authUrl: "https://example.com/auth",
        tokenUrl: "https://example.com/token",
        defaultScopes: ["read"],
        scopePolicy: {},
      },
    ]);

    const providers = listProviders();
    const provider = providers.find(
      (p) => p.providerKey === "no-flag-provider",
    );
    expect(provider).toBeDefined();
    expect(provider!.featureFlag).toBeNull();

    const config = makeConfig();
    expect(isProviderVisible(provider!, config)).toBe(true);
  });

  test("returns true when featureFlag is set and the flag is enabled", () => {
    _setOverridesForTesting({ "test-gate": true });

    seedProviders([
      {
        providerKey: "gated-provider",
        authUrl: "https://example.com/auth",
        tokenUrl: "https://example.com/token",
        defaultScopes: ["read"],
        scopePolicy: {},
        featureFlag: "test-gate",
      },
    ]);

    const providers = listProviders();
    const provider = providers.find((p) => p.providerKey === "gated-provider");
    expect(provider).toBeDefined();
    expect(provider!.featureFlag).toBe("test-gate");

    const config = makeConfig();
    expect(isProviderVisible(provider!, config)).toBe(true);
  });

  test("returns false when featureFlag is set and the flag is disabled", () => {
    _setOverridesForTesting({ "test-gate": false });

    seedProviders([
      {
        providerKey: "gated-provider",
        authUrl: "https://example.com/auth",
        tokenUrl: "https://example.com/token",
        defaultScopes: ["read"],
        scopePolicy: {},
        featureFlag: "test-gate",
      },
    ]);

    const providers = listProviders();
    const provider = providers.find((p) => p.providerKey === "gated-provider");
    expect(provider).toBeDefined();

    const config = makeConfig();
    expect(isProviderVisible(provider!, config)).toBe(false);
  });

  test("listProviders returns all providers but isProviderVisible filters gated ones when flag is disabled", () => {
    _setOverridesForTesting({ "test-gate": false });

    seedProviders([
      {
        providerKey: "visible-provider",
        authUrl: "https://example.com/auth",
        tokenUrl: "https://example.com/token",
        defaultScopes: ["read"],
        scopePolicy: {},
      },
      {
        providerKey: "gated-provider",
        authUrl: "https://gated.example.com/auth",
        tokenUrl: "https://gated.example.com/token",
        defaultScopes: ["read"],
        scopePolicy: {},
        featureFlag: "test-gate",
      },
    ]);

    const allProviders = listProviders();
    expect(allProviders).toHaveLength(2);

    const config = makeConfig();
    const visibleProviders = allProviders.filter((p) =>
      isProviderVisible(p, config),
    );
    expect(visibleProviders).toHaveLength(1);
    expect(visibleProviders[0]!.providerKey).toBe("visible-provider");
  });
});

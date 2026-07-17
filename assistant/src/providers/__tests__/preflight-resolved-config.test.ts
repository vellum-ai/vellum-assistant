import { beforeEach, describe, expect, mock, test } from "bun:test";

let connectionsByName: Record<string, unknown> = {};
let secureKeys: Record<string, string | undefined> = {};
let cesUnreachable = false;
let platformLoggedIn = false;

mock.module("../../persistence/db-connection.js", () => ({
  getDb: () => ({}),
}));

mock.module("../inference/connections.js", () => ({
  getConnection: (_db: unknown, name: string) =>
    connectionsByName[name] ?? null,
  listConnections: () => [],
}));

mock.module("../provider-availability.js", () => ({
  checkCredentialPresence: async (account: string) =>
    cesUnreachable
      ? "indeterminate"
      : secureKeys[account] != null
        ? "present"
        : "absent",
}));

mock.module("../platform-proxy/context.js", () => ({
  hasManagedProxyPrereqs: async () => platformLoggedIn,
  resolveManagedProxyContext: async () => ({
    enabled: platformLoggedIn,
    // Base URL configured: an unauthenticated result must come from the
    // credential probe, so CES outages stay distinguishable.
    platformBaseUrl: "https://platform",
    assistantApiKey: platformLoggedIn ? "key" : "",
  }),
}));

import {
  ConnectionResolutionError,
  preflightResolvedConfig,
} from "../connection-resolution.js";

const resolved = (overrides: Partial<Record<string, string>> = {}) => ({
  provider: "anthropic",
  provider_connection: "anthropic-personal",
  model: "claude-opus-4-8",
  ...overrides,
});

async function preflightError(
  config: ReturnType<typeof resolved>,
): Promise<ConnectionResolutionError | undefined> {
  try {
    await preflightResolvedConfig(config, { profileName: "custom-fast" });
    return undefined;
  } catch (err) {
    expect(err).toBeInstanceOf(ConnectionResolutionError);
    return err as ConnectionResolutionError;
  }
}

beforeEach(() => {
  secureKeys = {};
  connectionsByName = {
    "anthropic-personal": {
      name: "anthropic-personal",
      provider: "anthropic",
      auth: {
        type: "api_key",
        credential: "credential/anthropic/api_key",
      },
    },
  };
  secureKeys = { "credential/anthropic/api_key": "sk-ant" };
  cesUnreachable = false;
  platformLoggedIn = false;
});

describe("preflightResolvedConfig", () => {
  test("healthy config passes silently", async () => {
    expect(await preflightError(resolved())).toBeUndefined();
  });

  test("no provider_connection on the config is not the preflight's concern", async () => {
    await preflightResolvedConfig(
      { provider: "anthropic", model: "claude-opus-4-8" },
      {},
    );
  });

  test("deleted connection throws not_found naming profile and model", async () => {
    connectionsByName = {};
    const err = await preflightError(resolved());
    expect(err?.reason).toBe("not_found");
    expect(err?.profileName).toBe("custom-fast");
    expect(err?.model).toBe("claude-opus-4-8");
    expect(err?.message).toContain("anthropic-personal");
  });

  test("missing credential throws missing_credential", async () => {
    secureKeys = {};
    const err = await preflightError(resolved());
    expect(err?.reason).toBe("missing_credential");
    expect(err?.message).toContain("API key");
  });

  test("CES-unreachable passes silently — never misreported as a missing credential", async () => {
    secureKeys = {};
    cesUnreachable = true;
    expect(await preflightError(resolved())).toBeUndefined();
  });

  test("provider mismatch throws provider_mismatch", async () => {
    connectionsByName["anthropic-personal"] = {
      name: "anthropic-personal",
      provider: "openai",
      auth: { type: "api_key", credential: "credential/openai/api_key" },
    };
    const err = await preflightError(resolved());
    expect(err?.reason).toBe("provider_mismatch");
  });

  test("the vellum managed connection serves managed-routable providers when logged in", async () => {
    connectionsByName = {
      vellum: {
        name: "vellum",
        provider: "vellum",
        auth: { type: "platform" },
      },
    };
    platformLoggedIn = true;
    expect(
      await preflightError(resolved({ provider_connection: "vellum" })),
    ).toBeUndefined();

    platformLoggedIn = false;
    const err = await preflightError(
      resolved({ provider_connection: "vellum" }),
    );
    expect(err?.reason).toBe("platform_unauthenticated");
  });

  test("the vellum managed connection rejects non-managed-routable providers", async () => {
    connectionsByName = {
      vellum: {
        name: "vellum",
        provider: "vellum",
        auth: { type: "platform" },
      },
    };
    platformLoggedIn = true;
    const err = await preflightError(
      resolved({ provider: "openrouter", provider_connection: "vellum" }),
    );
    expect(err?.reason).toBe("provider_mismatch");
  });

  test("platform-auth connections require a platform login", async () => {
    connectionsByName["anthropic-personal"] = {
      name: "anthropic-personal",
      provider: "anthropic",
      auth: { type: "platform" },
    };
    const err = await preflightError(resolved());
    expect(err?.reason).toBe("platform_unauthenticated");

    platformLoggedIn = true;
    expect(await preflightError(resolved())).toBeUndefined();
  });

  test("a credential-store outage on platform auth passes silently — never reported as logout", async () => {
    connectionsByName["anthropic-personal"] = {
      name: "anthropic-personal",
      provider: "anthropic",
      auth: { type: "platform" },
    };
    cesUnreachable = true;
    expect(await preflightError(resolved())).toBeUndefined();
  });

  test("keyless and unknown auth types pass through to dispatch", async () => {
    connectionsByName["anthropic-personal"] = {
      name: "anthropic-personal",
      provider: "anthropic",
      auth: { type: "none" },
    };
    expect(await preflightError(resolved())).toBeUndefined();
  });
});

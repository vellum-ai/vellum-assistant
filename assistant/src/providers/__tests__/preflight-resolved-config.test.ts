import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import * as realDbConnection from "../../persistence/db-connection.js";
import * as realLogger from "../../util/logger.js";
import * as realConnections from "../inference/connections.js";
import * as realPlatformProxy from "../platform-proxy/context.js";
import * as realProviderAvailability from "../provider-availability.js";

let connectionsByName: Record<string, unknown> = {};
let secureKeys: Record<string, string | undefined> = {};
let cesUnreachable = false;
let platformLoggedIn = false;

// The daemon reports to Sentry by logging at error level; spy on that call so
// the managed-absent alert is assertable without a Sentry SDK in the tests.
// The mocks spread their real modules so the dynamic import below links against
// complete namespaces, overriding only the functions each test drives.
const errorLogSpy = mock((..._args: unknown[]) => {});
const testLogger = {
  info: () => {},
  warn: () => {},
  error: errorLogSpy,
  debug: () => {},
};
mock.module("../../util/logger.js", () => ({
  ...realLogger,
  getLogger: () => testLogger,
}));

mock.module("../../persistence/db-connection.js", () => ({
  ...realDbConnection,
  getDb: () => ({}),
}));

mock.module("../inference/connections.js", () => ({
  ...realConnections,
  getConnection: (_db: unknown, name: string) =>
    connectionsByName[name] ?? null,
  listConnections: () => [],
}));

mock.module("../provider-availability.js", () => ({
  ...realProviderAvailability,
  checkCredentialPresence: async (account: string) =>
    cesUnreachable
      ? "indeterminate"
      : secureKeys[account] != null
        ? "present"
        : "absent",
}));

mock.module("../platform-proxy/context.js", () => ({
  ...realPlatformProxy,
  hasManagedProxyPrereqs: async () => platformLoggedIn,
  resolveManagedProxyContext: async () => ({
    enabled: platformLoggedIn,
    // Base URL configured: an unauthenticated result must come from the
    // credential probe, so CES outages stay distinguishable.
    platformBaseUrl: "https://platform",
    assistantApiKey: platformLoggedIn ? "key" : "",
  }),
}));

import type { ConnectionResolutionError } from "../connection-resolution.js";

// Imported after the mocks so the module-level logger is the spied one, letting
// the managed-absent Sentry alert be asserted (module-level `const log` binds at
// evaluation time, unlike the runtime-called db/context mocks).
const {
  ConnectionResolutionError: ConnectionResolutionErrorClass,
  preflightResolvedConfig,
} = await import("../connection-resolution.js");

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
    expect(err).toBeInstanceOf(ConnectionResolutionErrorClass);
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
  delete process.env.IS_CONTAINERIZED;
  errorLogSpy.mockClear();
});

afterEach(() => {
  delete process.env.IS_CONTAINERIZED;
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

  test("a vellum identity preflights through the sentinel row with the derived upstream", async () => {
    connectionsByName["vellum"] = {
      name: "vellum",
      provider: "vellum",
      auth: { type: "platform" },
    };
    platformLoggedIn = true;
    await expect(
      preflightResolvedConfig(
        resolved({ provider: "vellum", provider_connection: "" }),
        {},
      ),
    ).resolves.toBeUndefined();
  });

  test("a vellum identity without a platform login throws platform_unauthenticated", async () => {
    connectionsByName["vellum"] = {
      name: "vellum",
      provider: "vellum",
      auth: { type: "platform" },
    };
    platformLoggedIn = false;
    const err = await preflightError(
      resolved({ provider: "vellum", provider_connection: "" }),
    );
    expect(err?.reason).toBe("platform_unauthenticated");
  });

  test("a user-owned row claiming the vellum name preflights the platform", async () => {
    // Dispatch ignores that row, so its credential is irrelevant to the
    // verdict: signed in passes, signed out is the platform's own failure.
    connectionsByName["vellum"] = {
      name: "vellum",
      provider: "openai",
      auth: { type: "api_key", credential: "credential/openai/api_key" },
    };
    secureKeys["credential/openai/api_key"] = "sk-openai";
    const collided = resolved({
      provider: "vellum",
      provider_connection: "",
      model: "gpt-5.6-luna",
    });

    platformLoggedIn = true;
    await expect(
      preflightResolvedConfig(collided, {}),
    ).resolves.toBeUndefined();

    platformLoggedIn = false;
    const err = await preflightError(collided);
    expect(err?.reason).toBe("platform_unauthenticated");
  });

  test("an unroutable vellum model throws unroutable_managed_model", async () => {
    const err = await preflightError(
      resolved({
        provider: "vellum",
        provider_connection: "",
        model: "not-a-real-model",
      }),
    );
    expect(err?.reason).toBe("unroutable_managed_model");
  });

  test("a chatgpt identity preflights the subscription row's credential", async () => {
    connectionsByName["chatgpt-subscription"] = {
      name: "chatgpt-subscription",
      provider: "openai",
      auth: {
        type: "oauth_subscription",
        credential: "credential/chatgpt/access_token",
      },
    };
    const missing = await preflightError(
      resolved({
        provider: "chatgpt",
        provider_connection: "",
        model: "gpt-5.5",
      }),
    );
    expect(missing?.reason).toBe("missing_credential");

    secureKeys["credential/chatgpt/access_token"] = "tok";
    await expect(
      preflightResolvedConfig(
        resolved({
          provider: "chatgpt",
          provider_connection: "",
          model: "gpt-5.5",
        }),
        {},
      ),
    ).resolves.toBeUndefined();
  });

  test("a chatgpt identity with no subscription row throws not_found", async () => {
    const err = await preflightError(
      resolved({
        provider: "chatgpt",
        provider_connection: "",
        model: "gpt-5.5",
      }),
    );
    expect(err?.reason).toBe("not_found");
  });

  test("a chatgpt identity with a non-Codex model throws model_incompatible", async () => {
    const err = await preflightError(
      resolved({ provider: "chatgpt", provider_connection: "" }),
    );
    expect(err?.reason).toBe("model_incompatible");
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

describe("preflightResolvedConfig — managed-pod platform credential messaging", () => {
  const managedPod = () => {
    connectionsByName = {
      vellum: {
        name: "vellum",
        provider: "vellum",
        auth: { type: "platform" },
      },
    };
    process.env.IS_CONTAINERIZED = "true";
  };
  const managedRoute = () => resolved({ provider_connection: "vellum" });

  test("store unreachable surfaces a retriable message, no login text, no alert", async () => {
    managedPod();
    cesUnreachable = true;
    const err = await preflightError(managedRoute());
    expect(err?.reason).toBe("platform_unauthenticated");
    expect(err?.message).toContain("temporarily unavailable");
    expect(err?.message).not.toContain("log in");
    expect(errorLogSpy).not.toHaveBeenCalled();
  });

  test("credential absent reports platform-side repair and emits a Sentry event", async () => {
    managedPod();
    // Logged out with a reachable store means the credential is genuinely absent.
    const err = await preflightError(managedRoute());
    expect(err?.reason).toBe("platform_unauthenticated");
    expect(err?.message).toContain("requires platform-side repair");
    expect(err?.message).not.toContain("log in");
    expect(errorLogSpy).toHaveBeenCalledTimes(1);
    const [context] = errorLogSpy.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(context.connectionName).toBe("vellum");
    // The alert carries identifiers only — never the credential value.
    expect(JSON.stringify(context)).not.toContain("sk-");
  });

  test("a healthy platform login passes silently on a pod, no alert", async () => {
    managedPod();
    platformLoggedIn = true;
    expect(await preflightError(managedRoute())).toBeUndefined();
    expect(errorLogSpy).not.toHaveBeenCalled();
  });

  test("local install keeps the log-in-or-switch wording and raises no alert", async () => {
    connectionsByName = {
      vellum: {
        name: "vellum",
        provider: "vellum",
        auth: { type: "platform" },
      },
    };
    // IS_CONTAINERIZED left unset: this is a local / self-hosted install.
    const err = await preflightError(managedRoute());
    expect(err?.reason).toBe("platform_unauthenticated");
    expect(err?.message).toContain("log in or pick a different provider");
    expect(errorLogSpy).not.toHaveBeenCalled();
  });
});

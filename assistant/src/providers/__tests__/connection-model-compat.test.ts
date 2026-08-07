/**
 * Tests for the Codex-subscription model-compatibility gate on auto-resolved
 * provider connections.
 *
 * When a profile uses "Any active OpenAI connection" (no `provider_connection`
 * pinned), the daemon auto-picks an active OpenAI connection. An
 * `oauth_subscription` (ChatGPT Codex) connection hard-routes to the Codex
 * endpoint, which rejects non-Codex models with HTTP 400. The gate skips such
 * a connection during auto-resolution unless the model is Codex-compatible.
 *
 * Three layers are covered:
 *   1. `isConnectionCompatibleWithModel` — the pure predicate.
 *   2. `getConfiguredProvider` — the auto-resolution path that uses the
 *      predicate as an additional `.find()` filter, plus the pinned-connection
 *      path which bypasses the gate entirely.
 *   3. `isSubscriptionModelRejection`, the after-the-fact counterpart, for
 *      callers holding the failure that a bypassed gate produced.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { setConfig } from "../../__tests__/helpers/set-config.js";
import {
  type ProviderCredentialSource,
  ProviderError,
} from "../../util/errors.js";
import {
  isConnectionCompatibleWithModel,
  isSubscriptionModelRejection,
} from "../connection-model-compat.js";
import type { Auth } from "../inference/auth.js";

// ---------------------------------------------------------------------------
// Pure predicate tests — no mocking required.
// ---------------------------------------------------------------------------

const apiKeyAuth: Auth = { type: "api_key", credential: "credential/x" };
const platformAuth: Auth = { type: "platform" };
const oauthAuth: Auth = {
  type: "oauth_subscription",
  credential: "credential/x",
};

describe("isConnectionCompatibleWithModel", () => {
  test("api_key connection is compatible with any model", () => {
    const conn = { auth: apiKeyAuth };
    expect(isConnectionCompatibleWithModel(conn, "gpt-5")).toBe(true);
    expect(isConnectionCompatibleWithModel(conn, "gpt-5.4")).toBe(true);
  });

  test("platform connection is compatible with any model", () => {
    const conn = { auth: platformAuth };
    expect(isConnectionCompatibleWithModel(conn, "gpt-5.4-nano")).toBe(true);
  });

  test("oauth_subscription connection is incompatible with a non-Codex model", () => {
    const conn = { auth: oauthAuth };
    expect(isConnectionCompatibleWithModel(conn, "gpt-5")).toBe(false);
    expect(isConnectionCompatibleWithModel(conn, "gpt-5.4-nano")).toBe(false);
    expect(isConnectionCompatibleWithModel(conn, "gpt-5.5-pro")).toBe(false);
  });

  test("oauth_subscription connection is compatible with a Codex model", () => {
    const conn = { auth: oauthAuth };
    expect(isConnectionCompatibleWithModel(conn, "gpt-5.6-sol")).toBe(true);
    expect(isConnectionCompatibleWithModel(conn, "gpt-5.6-terra")).toBe(true);
    expect(isConnectionCompatibleWithModel(conn, "gpt-5.6-luna")).toBe(true);
    expect(isConnectionCompatibleWithModel(conn, "gpt-5.5")).toBe(true);
    expect(isConnectionCompatibleWithModel(conn, "gpt-5.4")).toBe(true);
    expect(isConnectionCompatibleWithModel(conn, "gpt-5.4-mini")).toBe(true);
    expect(isConnectionCompatibleWithModel(conn, "gpt-5.3-codex")).toBe(true);
  });

  test("undefined model applies no gating (compatible)", () => {
    const conn = { auth: oauthAuth };
    expect(isConnectionCompatibleWithModel(conn, undefined)).toBe(true);
  });
});

describe("isSubscriptionModelRejection", () => {
  /** A model the Codex subscription does not serve. */
  const UNSERVED = "gpt-5.4-nano";
  /** A model it does serve, so a 400 cannot be about the model. */
  const SERVED = "gpt-5.4";

  const rejection = (
    statusCode: number,
    credentialSource?: ProviderCredentialSource,
  ) => {
    const err = new ProviderError("rejected", "openai", statusCode);
    if (credentialSource) {
      err.attachRouteAttribution({ credentialSource });
    }
    return err;
  };

  test("a 400 refusing a model the subscription does not serve", () => {
    expect(
      isSubscriptionModelRejection(
        rejection(400, "oauth-subscription"),
        UNSERVED,
      ),
    ).toBe(true);
  });

  test("a 400 on an allowlisted model is an ordinary bad request", () => {
    // This endpoint is parameter sensitive and answers 400 for client faults
    // that have nothing to do with the model. Reporting one as a model
    // incompatibility would send the user to change a working setting.
    expect(
      isSubscriptionModelRejection(
        rejection(400, "oauth-subscription"),
        SERVED,
      ),
    ).toBe(false);
  });

  test("an unknown model is not enough to claim a model fault", () => {
    expect(
      isSubscriptionModelRejection(
        rejection(400, "oauth-subscription"),
        undefined,
      ),
    ).toBe(false);
  });

  test("other statuses on the subscription route stay retryable", () => {
    // Rate limits and outages clear on their own; only the 400 is the
    // endpoint refusing the request as configured.
    expect(
      isSubscriptionModelRejection(
        rejection(429, "oauth-subscription"),
        UNSERVED,
      ),
    ).toBe(false);
    expect(
      isSubscriptionModelRejection(
        rejection(500, "oauth-subscription"),
        UNSERVED,
      ),
    ).toBe(false);
  });

  test("a 400 on any other credential source is not this fault", () => {
    expect(isSubscriptionModelRejection(rejection(400, "byok"), UNSERVED)).toBe(
      false,
    );
    expect(
      isSubscriptionModelRejection(rejection(400, "vellum-managed"), UNSERVED),
    ).toBe(false);
    expect(isSubscriptionModelRejection(rejection(400), UNSERVED)).toBe(false);
  });

  test("non-provider errors are not rejections", () => {
    expect(isSubscriptionModelRejection(new Error("boom"), UNSERVED)).toBe(
      false,
    );
    expect(isSubscriptionModelRejection(undefined, UNSERVED)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration tests through `getConfiguredProvider` — module mocks below must
// be declared before the import-under-test.
// ---------------------------------------------------------------------------

const mockDbSentinel = { __mock: "db" };
mock.module("../../persistence/db-connection.js", () => ({
  getDb: () => mockDbSentinel,
}));

type Connection = {
  name: string;
  provider: string;
  auth: { type: string; credential?: string };
};

// Ordered list the mocked `listConnections` returns. `.find()` walks it in
// order, so insertion order is meaningful for these tests.
let fakeConnectionList: Connection[] = [];
const fakeConnectionsByName = new Map<string, Connection>();

mock.module("../inference/connections.js", () => ({
  getConnection: (_db: unknown, name: string) =>
    fakeConnectionsByName.get(name) ?? null,
  listConnections: (_db: unknown, filter?: { provider?: string }) =>
    filter?.provider
      ? fakeConnectionList.filter((c) => c.provider === filter.provider)
      : fakeConnectionList,
}));

// Records the connection name handed to the resolver so tests can assert
// which connection auto-resolution selected.
const resolveProviderCalls: Connection[] = [];

mock.module("../registry.js", () => ({
  getProvider: (name: string) => {
    throw new Error(`legacy getProvider should not be called: ${name}`);
  },
  initializeProviders: async () => {},
  listProviders: () => [{ name: "stub" }],
  resolveProviderFromConnection: async (connection: Connection) => {
    resolveProviderCalls.push(connection);
    return { name: connection.provider, tag: connection.name };
  },
}));

import { getConfiguredProvider } from "../provider-send-message.js";

function registerConnections(connections: Connection[]): void {
  fakeConnectionList = connections;
  for (const c of connections) {
    fakeConnectionsByName.set(c.name, c);
  }
}

function reset(): void {
  resolveProviderCalls.length = 0;
  fakeConnectionList = [];
  fakeConnectionsByName.clear();
  setConfig("llm", {});
}

const OPENAI_KEY: Connection = {
  name: "openai-key",
  provider: "openai",
  auth: { type: "api_key", credential: "credential/openai" },
};
const OPENAI_CODEX: Connection = {
  name: "openai-codex",
  provider: "openai",
  auth: {
    type: "oauth_subscription",
    credential: "credential/openai-codex/access_token",
  },
};

describe("auto-resolution skips oauth_subscription connections for non-Codex models", () => {
  beforeEach(reset);

  test("non-Codex model picks the api_key connection over a (first-listed) oauth_subscription one", async () => {
    // oauth_subscription listed FIRST — without the gate, insertion order
    // would have selected it and misrouted gpt-5 to the Codex endpoint.
    registerConnections([OPENAI_CODEX, OPENAI_KEY]);
    setOpenAiProfile("gpt-5");

    const result = await getConfiguredProvider("mainAgent", {
      overrideProfile: "openai-any",
    });

    expect(result).not.toBeNull();
    expect(resolveProviderCalls.length).toBe(1);
    expect(resolveProviderCalls[0].name).toBe("openai-key");
  });

  test("Codex model can select the oauth_subscription connection", async () => {
    registerConnections([OPENAI_CODEX, OPENAI_KEY]);
    setOpenAiProfile("gpt-5.4");

    const result = await getConfiguredProvider("mainAgent", {
      overrideProfile: "openai-any",
    });

    expect(result).not.toBeNull();
    expect(resolveProviderCalls.length).toBe(1);
    expect(resolveProviderCalls[0].name).toBe("openai-codex");
  });

  test("non-Codex model with only an oauth_subscription connection resolves to null (no misroute)", async () => {
    // Pure-predicate gate: the lone oauth_subscription connection is filtered
    // out, so auto-resolution finds nothing and the call site falls back
    // gracefully rather than dispatching gpt-5 to the Codex endpoint.
    registerConnections([OPENAI_CODEX]);
    setOpenAiProfile("gpt-5");

    const result = await getConfiguredProvider("mainAgent", {
      overrideProfile: "openai-any",
    });

    expect(result).toBeNull();
    expect(resolveProviderCalls.length).toBe(0);
  });

  test("explicitly pinned oauth_subscription connection is used regardless of model", async () => {
    registerConnections([OPENAI_CODEX, OPENAI_KEY]);
    setConfig("llm", {
      default: { provider: "anthropic", model: "claude-opus-4-7" },
      profiles: {
        "openai-pinned": {
          provider: "openai",
          model: "gpt-5",
          provider_connection: "openai-codex",
        },
      },
    });

    const result = await getConfiguredProvider("mainAgent", {
      overrideProfile: "openai-pinned",
    });

    // The pinned connection bypasses the auto-resolution gate entirely.
    expect(result).not.toBeNull();
    expect(resolveProviderCalls.length).toBe(1);
    expect(resolveProviderCalls[0].name).toBe("openai-codex");
  });
});

function setOpenAiProfile(model: string): void {
  setConfig("llm", {
    default: { provider: "anthropic", model: "claude-opus-4-7" },
    profiles: {
      // "Any active OpenAI connection" — provider set, no provider_connection.
      "openai-any": { provider: "openai", model },
    },
  });
}

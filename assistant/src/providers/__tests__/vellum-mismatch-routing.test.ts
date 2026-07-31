/**
 * Guards that a `vellum` provider_connection only takes the provider-agnostic
 * routing path when the resolving profile declares a managed-routable upstream.
 * A `vellum` connection paired with a non-managed provider (openrouter/ollama/…)
 * is a misconfiguration and must use the normal mismatch recovery/error path,
 * not route as platform auth and silently fall back.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const dbSentinel = { __mock: "db" };
mock.module("../../persistence/db-connection.js", () => ({
  getDb: () => dbSentinel,
}));

type Connection = {
  name: string;
  provider: string;
  auth: { type: string; credential?: string };
};

const fakeConnections = new Map<string, Connection>();
let listResult: Connection[] = [];
mock.module("../inference/connections.js", () => ({
  getConnection: (_db: unknown, name: string) =>
    fakeConnections.get(name) ?? null,
  listConnections: (_db: unknown, _filter?: { provider?: string }) =>
    listResult,
  canonicalVellumConnection: () => ({ ...vellumConn }),
}));

const resolveCalls: Array<{
  connection: Connection;
  opts: { model?: string; providerOverride?: string };
}> = [];
let resolveResult: unknown = undefined;
mock.module("../registry.js", () => ({
  resolveProviderFromConnection: async (
    connection: Connection,
    _config: unknown,
    opts: { model?: string; providerOverride?: string },
  ) => {
    resolveCalls.push({ connection, opts });
    // `undefined` means "use the default stub"; an explicit null models a
    // credential the vault cannot serve.
    return resolveResult === undefined
      ? { __provider: connection.name }
      : resolveResult;
  },
}));

mock.module("../connection-model-compat.js", () => ({
  isConnectionCompatibleWithModel: () => true,
  describeSubscriptionModelIncompatibility: () => null,
}));

import {
  ConnectionResolutionError,
  tryResolveProviderForConnectionName,
} from "../connection-resolution.js";
import type { ProvidersConfig } from "../registry.js";

const config = {} as unknown as ProvidersConfig;
const vellumConn: Connection = {
  name: "vellum",
  provider: "vellum",
  auth: { type: "platform" },
};

function reset(): void {
  resolveCalls.length = 0;
  fakeConnections.clear();
  listResult = [];
  resolveResult = undefined;
}

describe("vellum connection mismatch handling", () => {
  beforeEach(reset);

  test("managed-routable provider routes with providerOverride", async () => {
    fakeConnections.set("vellum", vellumConn);
    const provider = await tryResolveProviderForConnectionName(
      "vellum",
      config,
      "fireworks",
      "accounts/fireworks/models/kimi-k2p5",
    );
    expect(provider).not.toBeNull();
    expect(resolveCalls).toHaveLength(1);
    expect(resolveCalls[0].connection.name).toBe("vellum");
    expect(resolveCalls[0].opts.providerOverride).toBe("fireworks");
  });

  test("non-managed provider with no recovery throws provider_mismatch", async () => {
    fakeConnections.set("vellum", vellumConn);
    listResult = []; // no openrouter connection to recover to
    let caught: unknown;
    try {
      await tryResolveProviderForConnectionName(
        "vellum",
        config,
        "openrouter",
        "anthropic/claude-fable-5",
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConnectionResolutionError);
    expect((caught as ConnectionResolutionError).reason).toBe(
      "provider_mismatch",
    );
    // Never routed as a vellum platform-auth request.
    expect(resolveCalls).toHaveLength(0);
  });

  test("non-managed provider auto-recovers to a real connection (no override)", async () => {
    fakeConnections.set("vellum", vellumConn);
    listResult = [
      {
        name: "openrouter-personal",
        provider: "openrouter",
        auth: { type: "api_key", credential: "credential/openrouter/api_key" },
      },
    ];
    const provider = await tryResolveProviderForConnectionName(
      "vellum",
      config,
      "openrouter",
      "anthropic/claude-fable-5",
    );
    expect(provider).not.toBeNull();
    expect(resolveCalls).toHaveLength(1);
    expect(resolveCalls[0].connection.name).toBe("openrouter-personal");
    expect(resolveCalls[0].opts.providerOverride).toBeUndefined();
  });
});

/**
 * Boot seeding leaves a user-owned row claiming the `vellum` name in place, so
 * an install can have no canonical row at all. A managed profile only resolves
 * on a platform install, so its route is platform auth, never the credentials
 * that row happens to carry, and never an error over the name collision.
 */
describe("user-owned connection claiming the vellum name", () => {
  beforeEach(reset);

  const userOwnedOpenai: Connection = {
    name: "vellum",
    provider: "openai",
    auth: { type: "api_key", credential: "credential/openai/api_key" },
  };

  test("routes through platform auth, not the claiming row", async () => {
    // The row's provider equals the model's upstream, so plain provider
    // equality would have accepted it and billed the user's own key.
    fakeConnections.set("vellum", userOwnedOpenai);
    const provider = await tryResolveProviderForConnectionName(
      "vellum",
      config,
      "vellum",
      "gpt-5.6-luna",
    );
    expect(provider).not.toBeNull();
    expect(resolveCalls).toHaveLength(1);
    expect(resolveCalls[0].connection.auth.type).toBe("platform");
    expect(resolveCalls[0].opts.providerOverride).toBe("openai");
  });

  test("does not reroute onto another BYOK row for the upstream", async () => {
    fakeConnections.set("vellum", {
      name: "vellum",
      provider: "anthropic",
      auth: { type: "api_key", credential: "credential/anthropic/api_key" },
    });
    listResult = [
      {
        name: "openai-personal",
        provider: "openai",
        auth: { type: "api_key", credential: "credential/openai/api_key" },
      },
    ];
    await tryResolveProviderForConnectionName(
      "vellum",
      config,
      "vellum",
      "gpt-5.6-luna",
    );
    expect(resolveCalls).toHaveLength(1);
    expect(resolveCalls[0].connection.auth.type).toBe("platform");
  });

  test("an unavailable platform is a soft miss, not a fall-through", async () => {
    fakeConnections.set("vellum", userOwnedOpenai);
    resolveResult = null; // not signed in to the platform
    const provider = await tryResolveProviderForConnectionName(
      "vellum",
      config,
      "vellum",
      "gpt-5.6-luna",
    );
    expect(provider).toBeNull();
    expect(resolveCalls).toHaveLength(1);
    expect(resolveCalls[0].connection.auth.type).toBe("platform");
  });

  test("a concrete provider over the canonical name is still platform-billed", async () => {
    // The shape `resolveCallSiteConfig` produces when a call-site tweak pins a
    // concrete upstream over a managed profile: provider is the upstream, the
    // managed connection survives. The legacy config of the same shape (a BYOK
    // profile pointing at a row named `vellum`) resolves the same way.
    fakeConnections.set("vellum", userOwnedOpenai);
    const provider = await tryResolveProviderForConnectionName(
      "vellum",
      config,
      "openai",
      "gpt-5.6-luna",
    );
    expect(provider).not.toBeNull();
    expect(resolveCalls).toHaveLength(1);
    expect(resolveCalls[0].connection.auth.type).toBe("platform");
    expect(resolveCalls[0].opts.providerOverride).toBe("openai");
  });

  test("the canonical row still routes", async () => {
    fakeConnections.set("vellum", vellumConn);
    const provider = await tryResolveProviderForConnectionName(
      "vellum",
      config,
      "vellum",
      "gpt-5.6-luna",
    );
    expect(provider).not.toBeNull();
    expect(resolveCalls).toHaveLength(1);
    expect(resolveCalls[0].opts.providerOverride).toBe("openai");
  });
});

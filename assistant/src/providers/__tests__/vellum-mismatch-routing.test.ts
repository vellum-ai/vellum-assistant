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
}));

const resolveCalls: Array<{
  connection: Connection;
  opts: { model?: string; providerOverride?: string };
}> = [];
mock.module("../registry.js", () => ({
  resolveProviderFromConnection: async (
    connection: Connection,
    _config: unknown,
    opts: { model?: string; providerOverride?: string },
  ) => {
    resolveCalls.push({ connection, opts });
    return { __provider: connection.name };
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

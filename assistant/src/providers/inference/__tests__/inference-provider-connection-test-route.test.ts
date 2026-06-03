/**
 * Route-level tests for the provider-connection test/probe handler
 * (POST inference/provider-connections/:name/test).
 *
 * Mocks the DB, feature flags, config, secure-keys (credential lookup), and the
 * openai client's `probeOpenAICompatibleEndpoint` so the probe result is
 * controllable without any network access. Mirrors the mocking patterns in the
 * sibling base-url-route-validation.test.ts.
 */
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { migrateCreateProviderConnections } from "../../../memory/migrations/243-provider-connections.js";
import { migrateProviderConnectionStatusLabel } from "../../../memory/migrations/244-provider-connection-status-label.js";
import { migrateProviderConnectionBaseUrlAndModels } from "../../../memory/migrations/250-provider-connection-base-url-and-models.js";
import * as schema from "../../../memory/schema.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  return drizzle(sqlite, { schema });
}

function bootDb() {
  const db = createTestDb();
  migrateCreateProviderConnections(db);
  migrateProviderConnectionStatusLabel(db);
  migrateProviderConnectionBaseUrlAndModels(db);
  return db;
}

const testDb = bootDb();

mock.module("../../../memory/db-connection.js", () => ({
  getDb: () => testDb,
}));

mock.module("../../../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: (flag: string) =>
    flag === "openai-compatible-endpoints",
}));

mock.module("../../../config/loader.js", () => ({
  getConfig: () => ({ llm: {} }),
  getConfigReadOnly: () => ({ llm: {} }),
}));

mock.module("../../../config/env-registry.js", () => ({
  getIsPlatform: () => false,
}));

// Credential lookup for api_key auth: any credential resolves to a stub token.
// getProviderKeyAsync is exported for static-import linking only (the provider
// registry, pulled in transitively via connections.js, imports it); the test
// never exercises that path.
mock.module("../../../security/secure-keys.js", () => ({
  getSecureKeyAsync: async () => "stub-secret",
  getProviderKeyAsync: async () => null,
}));

// Controllable probe result. Each test sets `probeResult` and asserts the
// route returns it (or the skipped/ok branches) without hitting the network.
let probeResult: { ok: true } | { ok: false; reason: string } = { ok: true };
const probeMock = mock(
  async (_opts: { baseURL: string; apiKey?: string }) => probeResult,
);

mock.module("../../../providers/openai/client.js", () => ({
  probeOpenAICompatibleEndpoint: probeMock,
}));

const { ROUTES } =
  await import("../../../runtime/routes/inference-provider-connection-routes.js");

const handleTest = ROUTES.find(
  (r) => r.operationId === "inference_provider_connections_test",
)!.handler;

const handleCreate = ROUTES.find(
  (r) => r.operationId === "inference_provider_connections_create",
)!.handler;

beforeEach(() => {
  probeResult = { ok: true };
  probeMock.mockClear();
});

describe("test connection route", () => {
  test("throws NotFoundError for a missing connection", async () => {
    await expect(
      handleTest({ pathParams: { name: "does-not-exist" } }),
    ).rejects.toThrow(/not found/);
  });

  test("openai-compatible: a successful probe returns { ok: true }", async () => {
    await handleCreate({
      body: {
        name: "probe-ok",
        provider: "openai-compatible",
        auth: { type: "api_key", credential: "credential/probe-ok/api_key" },
        base_url: "https://api.example.com/v1",
        models: [{ id: "m" }],
      },
    });

    probeResult = { ok: true };
    const result = await handleTest({ pathParams: { name: "probe-ok" } });
    expect(result).toEqual({ ok: true });

    // The bearer is derived from the resolved Authorization header.
    expect(probeMock).toHaveBeenCalledTimes(1);
    const arg = probeMock.mock.calls[0][0];
    expect(arg.baseURL).toBe("https://api.example.com/v1");
    expect(arg.apiKey).toBe("stub-secret");
  });

  test("openai-compatible: a failing probe returns { ok: false, reason }", async () => {
    await handleCreate({
      body: {
        name: "probe-fail",
        provider: "openai-compatible",
        auth: { type: "none" },
        base_url: "https://unreachable.example.com/v1",
        models: [{ id: "m" }],
      },
    });

    probeResult = { ok: false, reason: "Could not reach the endpoint." };
    const result = await handleTest({ pathParams: { name: "probe-fail" } });
    expect(result).toEqual({
      ok: false,
      reason: "Could not reach the endpoint.",
    });

    // Keyless connection: no bearer derived.
    expect(probeMock.mock.calls[0][0].apiKey).toBe("");
  });

  test("non-openai-compatible connection returns { ok: true, skipped: true } and does not probe", async () => {
    await handleCreate({
      body: {
        name: "probe-anthropic",
        provider: "anthropic",
        auth: { type: "api_key", credential: "credential/anthropic/api_key" },
      },
    });

    const result = await handleTest({ pathParams: { name: "probe-anthropic" } });
    expect(result).toEqual({ ok: true, skipped: true });
    expect(probeMock).not.toHaveBeenCalled();
  });
});

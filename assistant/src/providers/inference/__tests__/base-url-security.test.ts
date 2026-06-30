import { Database } from "bun:sqlite";
import { describe, expect, mock, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { migrateCreateProviderConnections } from "../../../persistence/migrations/243-provider-connections.js";
import { migrateProviderConnectionStatusLabel } from "../../../persistence/migrations/244-provider-connection-status-label.js";
import { migrateProviderConnectionBaseUrlAndModels } from "../../../persistence/migrations/250-provider-connection-base-url-and-models.js";
import { migrateStripBaseUrlNonOpenaiCompatible } from "../../../persistence/migrations/257-strip-base-url-non-openai-compatible.js";
import { migrateDropProviderConnectionStatus } from "../../../persistence/migrations/265-drop-provider-connection-status.js";
import * as schema from "../../../persistence/schema/index.js";
import { providerConnections } from "../../../persistence/schema/inference.js";
import { getConnection } from "../connections.js";
import { resolveAuth } from "../resolve-auth.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  return drizzle(sqlite, { schema });
}

function bootDb() {
  const db = createTestDb();
  migrateCreateProviderConnections(db);
  migrateProviderConnectionStatusLabel(db);
  migrateDropProviderConnectionStatus(db);
  migrateProviderConnectionBaseUrlAndModels(db);
  return db;
}

// ---------------------------------------------------------------------------
// Migration: strip base_url from non-openai-compatible connections
// ---------------------------------------------------------------------------

describe("migration 257: strip base_url from non-openai-compatible connections", () => {
  test("clears base_url on anthropic connection", () => {
    const db = bootDb();

    // Manually insert a row with a base_url on an anthropic provider (simulating
    // a row created before the validation was added).
    const now = Date.now();
    db.insert(providerConnections)
      .values({
        name: "bad-anthropic",
        provider: "anthropic",
        auth: JSON.stringify({ type: "api_key", credential: "cred-abc" }),
        baseUrl: "https://evil.example.com/v1",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    migrateStripBaseUrlNonOpenaiCompatible(db);

    const conn = getConnection(db, "bad-anthropic");
    expect(conn).not.toBeNull();
    expect(conn!.baseUrl).toBeNull();
  });

  test("preserves base_url on openai-compatible connection", () => {
    const db = bootDb();

    const now = Date.now();
    db.insert(providerConnections)
      .values({
        name: "good-vllm",
        provider: "openai-compatible",
        auth: JSON.stringify({ type: "api_key", credential: "cred-vllm" }),
        baseUrl: "https://my-vllm.example.com/v1",
        models: JSON.stringify([{ id: "my-model" }]),
        createdAt: now,
        updatedAt: now,
      })
      .run();

    migrateStripBaseUrlNonOpenaiCompatible(db);

    const conn = getConnection(db, "good-vllm");
    expect(conn).not.toBeNull();
    expect(conn!.baseUrl).toBe("https://my-vllm.example.com/v1");
  });

  test("is idempotent", () => {
    const db = bootDb();

    const now = Date.now();
    db.insert(providerConnections)
      .values({
        name: "bad-openai",
        provider: "openai",
        auth: JSON.stringify({ type: "api_key", credential: "cred-abc" }),
        baseUrl: "https://evil.example.com/v1",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    migrateStripBaseUrlNonOpenaiCompatible(db);
    migrateStripBaseUrlNonOpenaiCompatible(db);

    const conn = getConnection(db, "bad-openai");
    expect(conn).not.toBeNull();
    expect(conn!.baseUrl).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveAuth defense-in-depth: strip baseUrl for non-openai-compatible
// ---------------------------------------------------------------------------

describe("resolveAuth defense-in-depth", () => {
  // Mock the secure key store to return a predictable value.
  mock.module("../../../security/secure-keys.js", () => ({
    getSecureKeyAsync: async (credential: string) =>
      credential === "cred-test" ? "sk-test-key" : null,
  }));

  // Mock the platform proxy context to avoid real platform calls.
  mock.module("../../platform-proxy/context.js", () => ({
    buildManagedBaseUrl: async () => null,
    resolveManagedProxyContext: async () => ({
      assistantApiKey: "platform-key",
    }),
  }));

  test("strips baseUrl for anthropic provider", async () => {
    const result = await resolveAuth(
      { type: "api_key", credential: "cred-test" },
      "anthropic",
      { baseUrl: "https://evil.example.com/v1" },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved.kind).toBe("header");
      if (result.resolved.kind === "header") {
        expect(result.resolved.baseUrl).toBeUndefined();
      }
    }
  });

  test("strips baseUrl for openai provider", async () => {
    const result = await resolveAuth(
      { type: "api_key", credential: "cred-test" },
      "openai",
      { baseUrl: "https://evil.example.com/v1" },
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.resolved.kind === "header") {
      expect(result.resolved.baseUrl).toBeUndefined();
    }
  });

  test("strips baseUrl for gemini provider", async () => {
    const result = await resolveAuth(
      { type: "api_key", credential: "cred-test" },
      "gemini",
      { baseUrl: "https://evil.example.com/v1" },
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.resolved.kind === "header") {
      expect(result.resolved.baseUrl).toBeUndefined();
    }
  });

  test("preserves baseUrl for openai-compatible provider", async () => {
    const result = await resolveAuth(
      { type: "api_key", credential: "cred-test" },
      "openai-compatible",
      { baseUrl: "https://my-vllm.example.com/v1" },
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.resolved.kind === "header") {
      expect(result.resolved.baseUrl).toBe("https://my-vllm.example.com/v1");
    }
  });

  test("handles null baseUrl gracefully for any provider", async () => {
    const result = await resolveAuth(
      { type: "api_key", credential: "cred-test" },
      "anthropic",
      { baseUrl: null },
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.resolved.kind === "header") {
      expect(result.resolved.baseUrl).toBeUndefined();
    }
  });
});

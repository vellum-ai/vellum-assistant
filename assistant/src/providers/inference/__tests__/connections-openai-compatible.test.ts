import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { migrateCreateProviderConnections } from "../../../persistence/migrations/243-provider-connections.js";
import { migrateProviderConnectionStatusLabel } from "../../../persistence/migrations/244-provider-connection-status-label.js";
import { migrateProviderConnectionBaseUrlAndModels } from "../../../persistence/migrations/250-provider-connection-base-url-and-models.js";
import * as schema from "../../../persistence/schema/index.js";
import {
  createConnection,
  getConnection,
  listConnections,
  updateConnection,
} from "../connections.js";

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

describe("openai-compatible connection CRUD", () => {
  test("create requires base_url", () => {
    const db = bootDb();
    const result = createConnection(db, {
      name: "my-vllm",
      provider: "openai-compatible",
      auth: { type: "api_key", credential: "cred-vllm" },
      models: [{ id: "my-model" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("base_url_required");
    }
  });

  test("create requires at least one model", () => {
    const db = bootDb();
    const result = createConnection(db, {
      name: "my-vllm",
      provider: "openai-compatible",
      auth: { type: "api_key", credential: "cred-vllm" },
      baseUrl: "http://localhost:8080/v1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("models_required");
    }
  });

  test("create rejects empty models array", () => {
    const db = bootDb();
    const result = createConnection(db, {
      name: "my-vllm",
      provider: "openai-compatible",
      auth: { type: "api_key", credential: "cred-vllm" },
      baseUrl: "http://localhost:8080/v1",
      models: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("models_required");
    }
  });

  test("create persists baseUrl and models; round-trips via getConnection", () => {
    const db = bootDb();
    const models = [
      { id: "llama-3-70b" },
      { id: "mistral-7b", displayName: "Mistral 7B" },
    ];
    const result = createConnection(db, {
      name: "my-vllm",
      provider: "openai-compatible",
      auth: { type: "api_key", credential: "cred-vllm" },
      baseUrl: "http://localhost:8080/v1",
      models,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.connection.baseUrl).toBe("http://localhost:8080/v1");
      expect(result.connection.models).toEqual(models);
    }

    const fetched = getConnection(db, "my-vllm");
    expect(fetched).not.toBeNull();
    expect(fetched!.baseUrl).toBe("http://localhost:8080/v1");
    expect(fetched!.models).toEqual(models);
  });

  test("non-openai-compatible providers leave baseUrl/models null", () => {
    const db = bootDb();
    const result = createConnection(db, {
      name: "my-anthropic",
      provider: "anthropic",
      auth: { type: "api_key", credential: "cred-anthropic" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.connection.baseUrl).toBeNull();
      expect(result.connection.models).toBeNull();
    }
  });

  test("updateConnection can change models without re-supplying baseUrl", () => {
    const db = bootDb();
    createConnection(db, {
      name: "my-vllm",
      provider: "openai-compatible",
      auth: { type: "api_key", credential: "cred-vllm" },
      baseUrl: "http://localhost:8080/v1",
      models: [{ id: "llama-3-70b" }],
    });

    const result = updateConnection(db, "my-vllm", {
      auth: { type: "api_key", credential: "cred-vllm" },
      models: [{ id: "llama-3-70b" }, { id: "mistral-7b" }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.connection.baseUrl).toBe("http://localhost:8080/v1");
      expect(result.connection.models).toEqual([
        { id: "llama-3-70b" },
        { id: "mistral-7b" },
      ]);
    }
  });

  test("updateConnection rejects clearing models on openai-compatible", () => {
    const db = bootDb();
    createConnection(db, {
      name: "my-vllm",
      provider: "openai-compatible",
      auth: { type: "api_key", credential: "cred-vllm" },
      baseUrl: "http://localhost:8080/v1",
      models: [{ id: "llama-3-70b" }],
    });

    const result = updateConnection(db, "my-vllm", {
      auth: { type: "api_key", credential: "cred-vllm" },
      models: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("models_required");
    }
  });

  test("listConnections includes baseUrl and models", () => {
    const db = bootDb();
    createConnection(db, {
      name: "my-vllm",
      provider: "openai-compatible",
      auth: { type: "api_key", credential: "cred-vllm" },
      baseUrl: "http://localhost:8080/v1",
      models: [{ id: "llama-3-70b" }],
    });

    const connections = listConnections(db, {
      provider: "openai-compatible",
    });
    expect(connections.length).toBe(1);
    expect(connections[0]!.baseUrl).toBe("http://localhost:8080/v1");
    expect(connections[0]!.models).toEqual([{ id: "llama-3-70b" }]);
  });
});

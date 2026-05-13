import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { migrateCreateProviderConnections } from "../../../memory/migrations/243-provider-connections.js";
import { migrateProviderConnectionStatusLabel } from "../../../memory/migrations/244-provider-connection-status-label.js";
import { migrateProviderConnectionBaseUrlAndModels } from "../../../memory/migrations/247-provider-connection-base-url-and-models.js";
import * as schema from "../../../memory/schema.js";
import {
  createConnection,
  getConnection,
  listConnections,
  updateConnection,
} from "../connections.js";

function bootDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  const db = drizzle(sqlite, { schema });
  migrateCreateProviderConnections(db);
  migrateProviderConnectionStatusLabel(db);
  migrateProviderConnectionBaseUrlAndModels(db);
  return db;
}

describe("openai-compatible connection CRUD", () => {
  test("create requires base_url and at least one model", () => {
    const db = bootDb();

    const missingBase = createConnection(db, {
      name: "z-ai-1",
      provider: "openai-compatible",
      auth: { type: "api_key", credential: "secret-1" },
      models: [{ id: "glm-4.7" }],
    });
    expect(missingBase.ok).toBe(false);
    if (!missingBase.ok) {
      expect(missingBase.error.code).toBe("base_url_required");
    }

    const missingModels = createConnection(db, {
      name: "z-ai-2",
      provider: "openai-compatible",
      auth: { type: "api_key", credential: "secret-2" },
      baseUrl: "https://api.z.ai/api/coding/paas/v4",
      models: [],
    });
    expect(missingModels.ok).toBe(false);
    if (!missingModels.ok) {
      expect(missingModels.error.code).toBe("models_required");
    }
  });

  test("create persists baseUrl and models; round-trips via getConnection", () => {
    const db = bootDb();
    const result = createConnection(db, {
      name: "my-zai",
      provider: "openai-compatible",
      auth: { type: "api_key", credential: "secret-3" },
      baseUrl: "https://api.z.ai/api/coding/paas/v4",
      models: [{ id: "glm-4.7", displayName: "GLM 4.7" }, { id: "glm-5" }],
      label: "Z.ai (coding)",
    });
    expect(result.ok).toBe(true);

    const fetched = getConnection(db, "my-zai");
    expect(fetched).not.toBeNull();
    expect(fetched!.baseUrl).toBe("https://api.z.ai/api/coding/paas/v4");
    expect(fetched!.models).toEqual([
      { id: "glm-4.7", displayName: "GLM 4.7" },
      { id: "glm-5" },
    ]);
    expect(fetched!.label).toBe("Z.ai (coding)");
  });

  test("non-openai-compatible providers leave baseUrl/models null by default", () => {
    const db = bootDb();
    const result = createConnection(db, {
      name: "my-anthropic",
      provider: "anthropic",
      auth: { type: "api_key", credential: "anth-key" },
    });
    expect(result.ok).toBe(true);

    const fetched = getConnection(db, "my-anthropic");
    expect(fetched).not.toBeNull();
    expect(fetched!.baseUrl).toBeNull();
    expect(fetched!.models).toBeNull();
  });

  test("updateConnection can change models without re-supplying baseUrl", () => {
    const db = bootDb();
    createConnection(db, {
      name: "my-zai",
      provider: "openai-compatible",
      auth: { type: "api_key", credential: "secret-4" },
      baseUrl: "https://api.z.ai/api/coding/paas/v4",
      models: [{ id: "glm-4.7" }],
    });

    const updated = updateConnection(db, "my-zai", {
      auth: { type: "api_key", credential: "secret-4" },
      models: [{ id: "glm-4.7" }, { id: "glm-5.1" }],
    });
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      expect(updated.connection.models).toEqual([
        { id: "glm-4.7" },
        { id: "glm-5.1" },
      ]);
      expect(updated.connection.baseUrl).toBe(
        "https://api.z.ai/api/coding/paas/v4",
      );
    }
  });

  test("updateConnection rejects clearing models on openai-compatible", () => {
    const db = bootDb();
    createConnection(db, {
      name: "my-zai",
      provider: "openai-compatible",
      auth: { type: "api_key", credential: "secret-5" },
      baseUrl: "https://api.z.ai/api/coding/paas/v4",
      models: [{ id: "glm-4.7" }],
    });

    const cleared = updateConnection(db, "my-zai", {
      auth: { type: "api_key", credential: "secret-5" },
      models: [],
    });
    expect(cleared.ok).toBe(false);
    if (!cleared.ok) {
      expect(cleared.error.code).toBe("models_required");
    }

    const cleared2 = updateConnection(db, "my-zai", {
      auth: { type: "api_key", credential: "secret-5" },
      baseUrl: null,
    });
    expect(cleared2.ok).toBe(false);
    if (!cleared2.ok) {
      expect(cleared2.error.code).toBe("base_url_required");
    }
  });

  test("listConnections includes baseUrl and models for openai-compatible rows", () => {
    const db = bootDb();
    createConnection(db, {
      name: "a",
      provider: "openai-compatible",
      auth: { type: "api_key", credential: "a" },
      baseUrl: "https://a.example.com/v1",
      models: [{ id: "m1" }],
    });
    createConnection(db, {
      name: "b",
      provider: "anthropic",
      auth: { type: "api_key", credential: "b" },
    });

    const rows = listConnections(db).filter((r) => !r.isManaged);
    expect(rows).toHaveLength(2);
    const a = rows.find((r) => r.name === "a");
    const b = rows.find((r) => r.name === "b");
    expect(a?.baseUrl).toBe("https://a.example.com/v1");
    expect(a?.models).toEqual([{ id: "m1" }]);
    expect(b?.baseUrl).toBeNull();
    expect(b?.models).toBeNull();
  });
});

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

describe("ollama connection CRUD", () => {
  test("create without baseUrl leaves it null and does not require models", () => {
    const db = bootDb();
    const result = createConnection(db, {
      name: "ollama-local",
      provider: "ollama",
      auth: { type: "none" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.connection.baseUrl).toBeNull();
      expect(result.connection.models).toBeNull();
    }
  });

  test("create persists an optional baseUrl", () => {
    const db = bootDb();
    const result = createConnection(db, {
      name: "ollama-remote",
      provider: "ollama",
      auth: { type: "none" },
      baseUrl: "http://192.168.1.50:11434/v1",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.connection.baseUrl).toBe("http://192.168.1.50:11434/v1");
      expect(result.connection.models).toBeNull();
    }

    const fetched = getConnection(db, "ollama-remote");
    expect(fetched).not.toBeNull();
    expect(fetched!.baseUrl).toBe("http://192.168.1.50:11434/v1");
  });

  test("update can change and then clear baseUrl", () => {
    const db = bootDb();
    createConnection(db, {
      name: "ollama-local",
      provider: "ollama",
      auth: { type: "none" },
    });

    const updated = updateConnection(db, "ollama-local", {
      auth: { type: "none" },
      baseUrl: "http://127.0.0.1:11434/v1",
    });
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      expect(updated.connection.baseUrl).toBe("http://127.0.0.1:11434/v1");
    }

    const cleared = updateConnection(db, "ollama-local", {
      auth: { type: "none" },
      baseUrl: null,
    });
    expect(cleared.ok).toBe(true);
    if (cleared.ok) {
      expect(cleared.connection.baseUrl).toBeNull();
    }
  });
});

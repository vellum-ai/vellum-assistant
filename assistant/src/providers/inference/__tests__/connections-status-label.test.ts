import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { migrateCreateProviderConnections } from "../../../memory/migrations/243-provider-connections.js";
import { migrateProviderConnectionStatusLabel } from "../../../memory/migrations/244-provider-connection-status-label.js";
import * as schema from "../../../memory/schema.js";
import { createConnection, getConnection, updateConnection } from "../connections.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  return drizzle(sqlite, { schema });
}

function bootDb() {
  const db = createTestDb();
  migrateCreateProviderConnections(db);
  migrateProviderConnectionStatusLabel(db);
  return db;
}

describe("connection CRUD status + label defaults", () => {
  test("new connection without status/label gets status=active and label=null", () => {
    const db = bootDb();
    const result = createConnection(db, {
      name: "my-conn",
      provider: "anthropic",
      auth: { type: "platform" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.connection.status).toBe("active");
      expect(result.connection.label).toBeNull();
    }
  });

  test("createConnection passes explicit status and label", () => {
    const db = bootDb();
    const result = createConnection(db, {
      name: "disabled-conn",
      provider: "openai",
      auth: { type: "platform" },
      status: "disabled",
      label: "My OpenAI",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.connection.status).toBe("disabled");
      expect(result.connection.label).toBe("My OpenAI");
    }
  });

  test("getConnection returns status and label from DB", () => {
    const db = bootDb();
    createConnection(db, {
      name: "get-me",
      provider: "gemini",
      auth: { type: "platform" },
      status: "disabled",
      label: "Gemini Pro",
    });

    const conn = getConnection(db, "get-me");
    expect(conn).not.toBeNull();
    expect(conn!.status).toBe("disabled");
    expect(conn!.label).toBe("Gemini Pro");
  });

  test("updateConnection updates status", () => {
    const db = bootDb();
    createConnection(db, {
      name: "toggle-me",
      provider: "anthropic",
      auth: { type: "platform" },
    });

    const result = updateConnection(db, "toggle-me", {
      auth: { type: "platform" },
      status: "disabled",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.connection.status).toBe("disabled");
    }
  });

  test("updateConnection clears label when set to null", () => {
    const db = bootDb();
    createConnection(db, {
      name: "clear-label",
      provider: "openai",
      auth: { type: "platform" },
      label: "Old Label",
    });

    const result = updateConnection(db, "clear-label", {
      auth: { type: "platform" },
      label: null,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.connection.label).toBeNull();
    }
  });
});

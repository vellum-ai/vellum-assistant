import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { migrateCreateProviderConnections } from "../../../memory/migrations/243-provider-connections.js";
import { migrateProviderConnectionStatusLabel } from "../../../memory/migrations/244-provider-connection-status-label.js";
import { migrateProviderConnectionBaseUrlAndModels } from "../../../memory/migrations/250-provider-connection-base-url-and-models.js";
import { migrateDropProviderConnectionStatus } from "../../../memory/migrations/265-drop-provider-connection-status.js";
import * as schema from "../../../memory/schema.js";
import {
  createConnection,
  getConnection,
  listConnections,
  seedCanonicalConnections,
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
  // 244 adds status + label columns. 265 drops status. This mirrors the
  // production migration sequence so the Drizzle schema (which no longer
  // declares status) stays consistent with the DB shape.
  migrateProviderConnectionStatusLabel(db);
  migrateDropProviderConnectionStatus(db);
  migrateProviderConnectionBaseUrlAndModels(db);
  return db;
}

describe("connection CRUD label defaults", () => {
  test("new connection without label gets label=null", () => {
    const db = bootDb();
    const result = createConnection(db, {
      name: "my-conn",
      provider: "anthropic",
      auth: { type: "platform" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.connection.label).toBeNull();
    }
  });

  test("createConnection passes explicit label", () => {
    const db = bootDb();
    const result = createConnection(db, {
      name: "labeled-conn",
      provider: "openai",
      auth: { type: "platform" },
      label: "My OpenAI",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.connection.label).toBe("My OpenAI");
    }
  });

  test("getConnection returns label from DB", () => {
    const db = bootDb();
    createConnection(db, {
      name: "get-me",
      provider: "gemini",
      auth: { type: "platform" },
      label: "Gemini Pro",
    });

    const conn = getConnection(db, "get-me");
    expect(conn).not.toBeNull();
    expect(conn!.label).toBe("Gemini Pro");
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

describe("seedCanonicalConnections labels", () => {
  test("first boot seeds default labels on all managed connections", () => {
    const db = bootDb();
    seedCanonicalConnections(db);

    const conns = listConnections(db);
    const byName = Object.fromEntries(conns.map((c) => [c.name, c]));

    expect(byName["anthropic-managed"]?.label).toBe("Anthropic");
    expect(byName["openai-managed"]?.label).toBe("OpenAI");
    expect(byName["gemini-managed"]?.label).toBe("Google Gemini");
  });

  test("second boot preserves user-customized label", () => {
    const db = bootDb();
    seedCanonicalConnections(db);

    // User customizes the label.
    updateConnection(db, "anthropic-managed", {
      auth: { type: "platform" },
      label: "Work Anthropic",
    });

    // Reboot.
    seedCanonicalConnections(db);

    const conn = getConnection(db, "anthropic-managed");
    expect(conn?.label).toBe("Work Anthropic");
  });

  test("second boot backfills default label when existing row has null label", () => {
    const db = bootDb();

    // `bootDb()` runs migration 243 which already inserted the three
    // canonical rows with `label=null` (the label column was added by 244
    // and defaults NULL for pre-existing rows). This matches the state
    // every pre-label install carries forward into the boot that ships
    // the label seed.
    const before = getConnection(db, "anthropic-managed");
    expect(before?.label).toBeNull();

    seedCanonicalConnections(db);

    const after = getConnection(db, "anthropic-managed");
    expect(after?.label).toBe("Anthropic");
  });

  test("backfill fills null label on subsequent boot", () => {
    const db = bootDb();
    seedCanonicalConnections(db);

    // User clears the label (PATCH label: null).
    updateConnection(db, "openai-managed", {
      auth: { type: "platform" },
      label: null,
    });

    // Subsequent boots refill it — there's no distinction between "user
    // explicitly cleared" and "pre-seed row that never had one". Treating
    // both as "fill with default" is intentional; users who want a blank
    // label aren't a real cohort and we'd rather guarantee the default is
    // present for everyone.
    seedCanonicalConnections(db);

    const conn = getConnection(db, "openai-managed");
    expect(conn?.label).toBe("OpenAI");
  });
});

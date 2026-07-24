import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { migrateCreateProviderConnections } from "../../../persistence/migrations/243-provider-connections.js";
import { migrateProviderConnectionStatusLabel } from "../../../persistence/migrations/244-provider-connection-status-label.js";
import { migrateProviderConnectionBaseUrlAndModels } from "../../../persistence/migrations/250-provider-connection-base-url-and-models.js";
import { migrateDropProviderConnectionStatus } from "../../../persistence/migrations/265-drop-provider-connection-status.js";
import * as schema from "../../../persistence/schema/index.js";
import { providerConnections } from "../../../persistence/schema/inference.js";
import { normalizeCredentialRef } from "../../../security/credential-key.js";
import { createConnection, getConnection } from "../connections.js";

function bootDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  const db = drizzle(sqlite, { schema });
  migrateCreateProviderConnections(db);
  migrateProviderConnectionStatusLabel(db);
  migrateDropProviderConnectionStatus(db);
  migrateProviderConnectionBaseUrlAndModels(db);
  return db;
}

describe("normalizeCredentialRef", () => {
  test("maps the secrets-API wire name to the vault key", () => {
    expect(normalizeCredentialRef("openrouter:api_key")).toBe(
      "credential/openrouter/api_key",
    );
  });

  test("splits compound service names at the last colon", () => {
    expect(normalizeCredentialRef("integration:google:access_token")).toBe(
      "credential/integration:google/access_token",
    );
  });

  test("leaves vault keys and other refs untouched", () => {
    expect(normalizeCredentialRef("credential/openrouter/api_key")).toBe(
      "credential/openrouter/api_key",
    );
    expect(normalizeCredentialRef("openrouter")).toBe("openrouter");
    expect(normalizeCredentialRef("openrouter:")).toBe("openrouter:");
    expect(normalizeCredentialRef(":api_key")).toBe(":api_key");
  });
});

describe("connection credential normalization", () => {
  test("createConnection stores the vault-key form for a wire-name credential", () => {
    const db = bootDb();
    const result = createConnection(db, {
      name: "openrouter-conn",
      provider: "openrouter",
      auth: { type: "api_key", credential: "openrouter:api_key" },
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.connection.auth.type === "api_key") {
      expect(result.connection.auth.credential).toBe(
        "credential/openrouter/api_key",
      );
    }
  });

  test("getConnection heals a stored wire-name credential without a migration", () => {
    const db = bootDb();
    const now = Date.now();
    db.insert(providerConnections)
      .values({
        name: "legacy-openrouter",
        provider: "openrouter",
        auth: JSON.stringify({
          type: "api_key",
          credential: "openrouter:api_key",
        }),
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const conn = getConnection(db, "legacy-openrouter");
    expect(conn).not.toBeNull();
    if (conn?.auth.type === "api_key") {
      expect(conn.auth.credential).toBe("credential/openrouter/api_key");
    }
  });
});

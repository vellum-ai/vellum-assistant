import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import type { DrizzleDb } from "../../persistence/db-connection.js";
import { migrateCreateProviderConnections } from "../../persistence/migrations/243-provider-connections.js";
import { migrateProviderConnectionStatusLabel } from "../../persistence/migrations/244-provider-connection-status-label.js";
import { migrateProviderConnectionBaseUrlAndModels } from "../../persistence/migrations/250-provider-connection-base-url-and-models.js";
import * as schema from "../../persistence/schema/index.js";
import { createAdapterFromConnection } from "../inference/adapter-factory.js";
import type { ProviderConnection } from "../inference/auth.js";
import type { ResolvedAuth } from "../inference/auth.js";
import {
  createConnection,
  getConnection,
  listConnections,
} from "../inference/connections.js";
import { isVellumManagedConnection } from "../vellum-model-routing.js";

function setupDb(): DrizzleDb {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  const db = drizzle(sqlite, { schema });
  migrateCreateProviderConnections(db);
  migrateProviderConnectionStatusLabel(db);
  migrateProviderConnectionBaseUrlAndModels(db);
  return db;
}

const vellumConnection = {
  name: "vellum",
  provider: "vellum",
  auth: { type: "platform" },
  label: "Vellum",
} as unknown as ProviderConnection;

const resolvedAuth: ResolvedAuth = {
  kind: "header",
  headers: { Authorization: "Bearer test-key" },
  baseUrl: "https://platform.example/v1/runtime-proxy/fireworks",
};

describe("vellum connection routing", () => {
  test("isVellumManagedConnection identifies the sentinel connection", () => {
    expect(isVellumManagedConnection(vellumConnection)).toBe(true);
    expect(
      isVellumManagedConnection({
        provider: "fireworks",
        auth: { type: "platform" },
      }),
    ).toBe(false);
    // `vellum` provider with non-platform auth is not a managed vellum route.
    expect(
      isVellumManagedConnection({ provider: "vellum", auth: { type: "none" } }),
    ).toBe(false);
  });

  test("the vellum sentinel is not a real provider without an override", () => {
    // No `provider` override → effective provider is the `vellum` sentinel,
    // which has no catalog entry / adapter → null.
    const adapter = createAdapterFromConnection(
      vellumConnection,
      resolvedAuth,
      {
        model: "accounts/fireworks/models/kimi-k2p5",
      },
    );
    expect(adapter).toBeNull();
  });

  test("provider override routes the vellum connection to the real upstream", () => {
    const adapter = createAdapterFromConnection(
      vellumConnection,
      resolvedAuth,
      {
        model: "accounts/fireworks/models/kimi-k2p5",
        provider: "fireworks",
      },
    );
    expect(adapter).not.toBeNull();
  });
});

describe("vellum connection persistence (DB round-trip)", () => {
  // Guards the P1: a persisted `provider: "vellum"` row must survive the DB
  // loaders and create route, which validate against VALID_CONNECTION_PROVIDERS.
  // Without the sentinel on that allowlist these all reject the row and the
  // routing above never runs on a real config.
  test("createConnection accepts a vellum sentinel row", () => {
    const db = setupDb();
    const result = createConnection(db, {
      name: "vellum",
      provider: "vellum",
      auth: { type: "platform" },
      label: "Vellum",
    });
    expect(result.ok).toBe(true);
  });

  test("getConnection loads a persisted vellum row (not dropped as invalid)", () => {
    const db = setupDb();
    createConnection(db, {
      name: "vellum",
      provider: "vellum",
      auth: { type: "platform" },
    });
    const loaded = getConnection(db, "vellum");
    expect(loaded).not.toBeNull();
    expect(loaded?.provider).toBe("vellum");
    expect(isVellumManagedConnection(loaded!)).toBe(true);
  });

  test("listConnections includes a persisted vellum row", () => {
    const db = setupDb();
    createConnection(db, {
      name: "vellum",
      provider: "vellum",
      auth: { type: "platform" },
    });
    const names = listConnections(db).map((c) => c.name);
    expect(names).toContain("vellum");
  });
});

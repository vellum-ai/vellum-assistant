/**
 * Tests for provider_connections: migration, CRUD, and
 * mix-and-match E2E (two profiles, same provider, different connections).
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import type { DrizzleDb } from "../../persistence/db-connection.js";
import { getSqliteFrom } from "../../persistence/db-connection.js";
import { migrateCreateProviderConnections } from "../../persistence/migrations/243-provider-connections.js";
import { migrateProviderConnectionStatusLabel } from "../../persistence/migrations/244-provider-connection-status-label.js";
import { migrateProviderConnectionBaseUrlAndModels } from "../../persistence/migrations/250-provider-connection-base-url-and-models.js";
import * as schema from "../../persistence/schema/index.js";
import { AuthSchema } from "../inference/auth.js";
import {
  createConnection,
  deleteConnection,
  getConnection,
  listConnections,
  seedCanonicalConnections,
  updateConnection,
} from "../inference/connections.js";

// ---------------------------------------------------------------------------
// Setup — each test gets a fresh in-memory DB
// ---------------------------------------------------------------------------

function setupDb(): { db: DrizzleDb; raw: Database } {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  const raw = getSqliteFrom(db);
  migrateCreateProviderConnections(db);
  migrateProviderConnectionStatusLabel(db);
  migrateProviderConnectionBaseUrlAndModels(db);
  return { db, raw };
}

// ---------------------------------------------------------------------------
// Migration idempotency
// ---------------------------------------------------------------------------

describe("migrateCreateProviderConnections", () => {
  test("creates the provider_connections table", () => {
    const { raw } = setupDb();
    const rows = raw.query("SELECT name FROM provider_connections").all() as {
      name: string;
    }[];
    expect(Array.isArray(rows)).toBe(true);
  });

  test("seedCanonicalConnections seeds the provider-agnostic vellum connection", () => {
    const { db } = setupDb();
    seedCanonicalConnections(db);
    const vellum = getConnection(db, "vellum");
    expect(vellum).not.toBeNull();
    expect(vellum?.provider).toBe("vellum");
    expect(vellum?.auth.type).toBe("platform");
    // Derived from MANAGED_CONNECTION_NAMES → write-protected at the route layer.
    expect(vellum?.isManaged).toBe(true);
  });

  test("seedCanonicalConnections is idempotent", () => {
    const { db } = setupDb();
    // Run twice — should not throw or create duplicate vellum rows.
    seedCanonicalConnections(db);
    seedCanonicalConnections(db);
    const managed = listConnections(db, { provider: "vellum" });
    expect(managed.filter((c) => c.name === "vellum").length).toBe(1);
  });

  test("seedCanonicalConnections does not clobber a user connection named vellum", () => {
    const { db } = setupDb();
    // `vellum` was not reserved before consolidation, so an install may already
    // have a BYOK connection keyed `vellum`. Seeding must not rewrite it to the
    // platform-auth sentinel.
    createConnection(db, {
      name: "vellum",
      provider: "anthropic",
      auth: { type: "api_key", credential: "credential/anthropic/api_key" },
    });

    seedCanonicalConnections(db);

    const conn = getConnection(db, "vellum");
    expect(conn?.provider).toBe("anthropic");
    expect(conn?.auth.type).toBe("api_key");
  });
});

// ---------------------------------------------------------------------------
// Connection CRUD
// ---------------------------------------------------------------------------

describe("Connection CRUD", () => {
  test("createConnection — happy path", () => {
    const { db } = setupDb();
    const result = createConnection(db, {
      name: "my-anthropic",
      provider: "anthropic",
      auth: { type: "api_key", credential: "credential/anthropic/api_key" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.connection.name).toBe("my-anthropic");
    expect(result.connection.provider).toBe("anthropic");
    expect(result.connection.auth.type).toBe("api_key");
  });

  test("createConnection — rejects unknown provider", () => {
    const { db } = setupDb();
    const result = createConnection(db, {
      name: "bad-conn",
      provider: "unknown-llm" as never,
      auth: { type: "none" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("invalid_provider");
  });

  test("createConnection — rejects duplicate name", () => {
    const { db } = setupDb();
    createConnection(db, {
      name: "dup-conn",
      provider: "openai",
      auth: { type: "platform" },
    });
    const result = createConnection(db, {
      name: "dup-conn",
      provider: "openai",
      auth: { type: "platform" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("already_exists");
  });

  test("getConnection — returns null for unknown name", () => {
    const { db } = setupDb();
    expect(getConnection(db, "nonexistent")).toBeNull();
  });

  test("listConnections — filters by provider", () => {
    const { db } = setupDb();
    createConnection(db, {
      name: "test-openai",
      provider: "openai",
      auth: { type: "api_key", credential: "credential/openai/api_key" },
    });
    const openai = listConnections(db, { provider: "openai" });
    expect(openai.every((c) => c.provider === "openai")).toBe(true);
  });

  test("updateConnection — happy path", () => {
    const { db } = setupDb();
    createConnection(db, {
      name: "updatable",
      provider: "anthropic",
      auth: { type: "platform" },
    });
    const result = updateConnection(db, "updatable", {
      auth: { type: "api_key", credential: "credential/anthropic/api_key" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.connection.auth.type).toBe("api_key");
    const fetched = getConnection(db, "updatable");
    expect(fetched?.auth.type).toBe("api_key");
  });

  test("updateConnection — rejects unknown name", () => {
    const { db } = setupDb();
    const result = updateConnection(db, "ghost", { auth: { type: "none" } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("not_found");
  });

  test("deleteConnection — happy path", () => {
    const { db } = setupDb();
    createConnection(db, {
      name: "to-delete",
      provider: "gemini",
      auth: { type: "platform" },
    });
    const result = deleteConnection(db, "to-delete");
    expect(result.ok).toBe(true);
    expect(getConnection(db, "to-delete")).toBeNull();
  });

  test("deleteConnection — rejects unknown name", () => {
    const { db } = setupDb();
    const result = deleteConnection(db, "ghost");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("not_found");
  });

  test("deleteConnection — rejects when profiles reference it (no --force)", () => {
    const { db } = setupDb();
    createConnection(db, {
      name: "referenced",
      provider: "anthropic",
      auth: { type: "platform" },
    });
    const result = deleteConnection(db, "referenced", {
      force: false,
      referencingProfiles: ["profile-a", "profile-b"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("has_references");
    if (result.error.code !== "has_references") return;
    expect(result.error.count).toBe(2);
  });

  test("deleteConnection --force removes even with references", () => {
    const { db } = setupDb();
    createConnection(db, {
      name: "force-delete",
      provider: "anthropic",
      auth: { type: "platform" },
    });
    const result = deleteConnection(db, "force-delete", {
      force: true,
      referencingProfiles: ["some-profile"],
    });
    expect(result.ok).toBe(true);
    expect(getConnection(db, "force-delete")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Auth schema validation
// ---------------------------------------------------------------------------

describe("AuthSchema", () => {
  test("api_key variant requires credential", () => {
    const ok = AuthSchema.safeParse({
      type: "api_key",
      credential: "cred/foo/api_key",
    });
    expect(ok.success).toBe(true);

    const bad = AuthSchema.safeParse({ type: "api_key" }); // missing credential
    expect(bad.success).toBe(false);
  });

  test("platform variant has no extra fields", () => {
    const ok = AuthSchema.safeParse({ type: "platform" });
    expect(ok.success).toBe(true);
  });

  test("none variant parses", () => {
    const ok = AuthSchema.safeParse({ type: "none" });
    expect(ok.success).toBe(true);
  });

  test("oauth_subscription and service_account parse (v2 variants, runtime-rejected)", () => {
    expect(
      AuthSchema.safeParse({ type: "oauth_subscription", credential: "x" })
        .success,
    ).toBe(true);
    expect(
      AuthSchema.safeParse({ type: "service_account", credential: "x" })
        .success,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Mix-and-match correctness
// ---------------------------------------------------------------------------

describe("Mix-and-match: two profiles, same provider, different connections", () => {
  test("getConnection returns the right auth for each connection name", () => {
    const { db } = setupDb();

    // Two connections for the same provider with distinct auth resolve
    // independently: one platform-auth, one personal api_key.
    createConnection(db, {
      name: "anthropic-platform",
      provider: "anthropic",
      auth: { type: "platform" },
    });
    createConnection(db, {
      name: "anthropic-personal",
      provider: "anthropic",
      auth: { type: "api_key", credential: "credential/anthropic/api_key" },
    });

    expect(getConnection(db, "anthropic-platform")?.auth.type).toBe("platform");
    expect(getConnection(db, "anthropic-personal")?.auth.type).toBe("api_key");

    // Both connections exist for the same provider.
    const anthropicConns = listConnections(db, { provider: "anthropic" });
    const names = anthropicConns.map((c) => c.name);
    expect(names).toContain("anthropic-platform");
    expect(names).toContain("anthropic-personal");

    // Auth is distinct per connection.
    const platform = anthropicConns.find(
      (c) => c.name === "anthropic-platform",
    );
    const personal = anthropicConns.find(
      (c) => c.name === "anthropic-personal",
    );
    expect(platform?.auth.type).toBe("platform");
    expect(personal?.auth.type).toBe("api_key");
  });
});

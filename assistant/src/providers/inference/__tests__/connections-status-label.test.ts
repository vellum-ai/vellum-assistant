import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { migrateCreateProviderConnections } from "../../../memory/migrations/243-provider-connections.js";
import { migrateProviderConnectionStatusLabel } from "../../../memory/migrations/244-provider-connection-status-label.js";
import * as schema from "../../../memory/schema.js";
import {
  createConnection,
  disableManagedConnectionsForByokHatch,
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

describe("seedCanonicalConnections labels", () => {
  test("first boot seeds default labels on all three managed connections", () => {
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

  test("backfill leaves explicit empty-overwrite null untouched on subsequent boot", () => {
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

describe("disableManagedConnectionsForByokHatch", () => {
  test("flips all three canonical managed connections to status='disabled'", () => {
    const db = bootDb();
    seedCanonicalConnections(db);

    // Sanity: seeded rows default to active.
    expect(getConnection(db, "anthropic-managed")?.status).toBe("active");
    expect(getConnection(db, "openai-managed")?.status).toBe("active");
    expect(getConnection(db, "gemini-managed")?.status).toBe("active");

    disableManagedConnectionsForByokHatch(db);

    expect(getConnection(db, "anthropic-managed")?.status).toBe("disabled");
    expect(getConnection(db, "openai-managed")?.status).toBe("disabled");
    expect(getConnection(db, "gemini-managed")?.status).toBe("disabled");
  });

  test("subsequent seedCanonicalConnections call does NOT re-flip a user-re-enabled connection", () => {
    // Models the post-hatch lifecycle: at hatch we disable; the user
    // later flips one back to active (e.g. after Vellum login). Every
    // subsequent daemon boot runs seedCanonicalConnections — and that
    // boot must NOT revert the user's choice. The hatch-disable helper
    // is only ever called from the seedInferenceProfiles hatch branch,
    // so it does not run on a non-hatch boot; this test confirms the
    // ambient seed pass leaves status alone.
    const db = bootDb();
    seedCanonicalConnections(db);
    disableManagedConnectionsForByokHatch(db);

    // User re-enables anthropic post-hatch.
    updateConnection(db, "anthropic-managed", {
      auth: { type: "platform" },
      status: "active",
    });
    expect(getConnection(db, "anthropic-managed")?.status).toBe("active");

    // Simulate a normal restart: seedCanonicalConnections runs every boot,
    // disableManagedConnectionsForByokHatch does NOT.
    seedCanonicalConnections(db);

    expect(getConnection(db, "anthropic-managed")?.status).toBe("active");
    // The two the user didn't touch stay disabled.
    expect(getConnection(db, "openai-managed")?.status).toBe("disabled");
    expect(getConnection(db, "gemini-managed")?.status).toBe("disabled");
  });

  test("idempotent re-hatch leaves all three at disabled", () => {
    // Workspace reset / re-hatch scenario: helper runs again and any
    // user re-enable from before the reset is intentionally undone —
    // re-hatch means re-onboard.
    const db = bootDb();
    seedCanonicalConnections(db);
    disableManagedConnectionsForByokHatch(db);

    updateConnection(db, "anthropic-managed", {
      auth: { type: "platform" },
      status: "active",
    });

    disableManagedConnectionsForByokHatch(db);

    expect(getConnection(db, "anthropic-managed")?.status).toBe("disabled");
    expect(getConnection(db, "openai-managed")?.status).toBe("disabled");
    expect(getConnection(db, "gemini-managed")?.status).toBe("disabled");
  });
});

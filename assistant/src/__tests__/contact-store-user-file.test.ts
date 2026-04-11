import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import {
  generateUserFileSlug,
  upsertContact,
} from "../contacts/contact-store.js";
import { getDb, getSqlite, initializeDb } from "../memory/db.js";
import { migrateNormalizeUserFileByPrincipal } from "../memory/migrations/220-normalize-user-file-by-principal.js";

initializeDb();

function resetContactTables(): void {
  const sqlite = getSqlite();
  sqlite.run("DELETE FROM contact_channels");
  sqlite.run("DELETE FROM contacts");
  sqlite.run(
    "DELETE FROM memory_checkpoints WHERE key = 'migration_normalize_user_file_by_principal_v1'",
  );
}

function insertContact(params: {
  id: string;
  displayName: string;
  role: string;
  principalId: string | null;
  userFile: string | null;
  createdAt: number;
}): void {
  const sqlite = getSqlite();
  sqlite.run(
    "INSERT INTO contacts (id, display_name, role, contact_type, principal_id, user_file, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [
      params.id,
      params.displayName,
      params.role,
      "human",
      params.principalId,
      params.userFile,
      params.createdAt,
      params.createdAt,
    ],
  );
}

function fetchUserFilesByPrincipal(
  principalId: string,
): Array<{ id: string; user_file: string | null }> {
  const sqlite = getSqlite();
  return sqlite
    .query(
      "SELECT id, user_file FROM contacts WHERE principal_id = ? ORDER BY id",
    )
    .all(principalId) as Array<{ id: string; user_file: string | null }>;
}

describe("upsertContact user_file selection", () => {
  beforeEach(() => {
    resetContactTables();
  });

  test("reuses an existing sibling's userFile when principalId matches", () => {
    const primary = upsertContact({
      displayName: "Sidd",
      role: "guardian",
      principalId: "principal-abc",
      channels: [
        {
          type: "vellum",
          address: "vellum-principal-abc",
          externalUserId: "vellum-principal-abc",
        },
      ],
    });
    expect(primary.userFile).toBe("sidd.md");

    // Second contact for the same principal on Slack — must inherit the
    // first contact's userFile, NOT auto-increment to sidd-2.md.
    const slack = upsertContact({
      displayName: "sidd",
      role: "guardian",
      principalId: "principal-abc",
      channels: [
        {
          type: "slack",
          address: "u123456",
          externalUserId: "U123456",
          externalChatId: "D987654",
        },
      ],
    });
    expect(slack.userFile).toBe("sidd.md");
    expect(slack.id).not.toBe(primary.id);
  });

  test("falls back to generateUserFileSlug when principalId has no existing sibling", () => {
    const contact = upsertContact({
      displayName: "Alice",
      role: "contact",
      principalId: "principal-alone",
      channels: [
        {
          type: "slack",
          address: "ualice",
          externalUserId: "UALICE",
          externalChatId: "DALICE",
        },
      ],
    });
    expect(contact.userFile).toBe("alice.md");
  });

  test("still auto-increments when principalId is not set and displayName collides", () => {
    const first = upsertContact({
      displayName: "Akash",
      role: "contact",
      channels: [
        {
          type: "slack",
          address: "uakash1",
          externalUserId: "UAKASH1",
          externalChatId: "DAKASH1",
        },
      ],
    });
    const second = upsertContact({
      displayName: "Akash",
      role: "contact",
      channels: [
        {
          type: "slack",
          address: "uakash2",
          externalUserId: "UAKASH2",
          externalChatId: "DAKASH2",
        },
      ],
    });
    expect(first.userFile).toBe("akash.md");
    expect(second.userFile).toBe("akash-2.md");
  });

  test("ignores a sibling whose userFile is null and generates a new slug", () => {
    insertContact({
      id: "seed-null",
      displayName: "legacy",
      role: "guardian",
      principalId: "principal-null",
      userFile: null,
      createdAt: Date.now(),
    });

    const contact = upsertContact({
      displayName: "Legacy",
      role: "guardian",
      principalId: "principal-null",
      channels: [
        {
          type: "phone",
          address: "+15550000",
          externalUserId: "+15550000",
          externalChatId: "+15550000",
        },
      ],
    });
    expect(contact.userFile).toBe("legacy.md");
  });
});

describe("generateUserFileSlug", () => {
  beforeEach(() => {
    resetContactTables();
  });

  test("returns base slug when unused", () => {
    expect(generateUserFileSlug("Alice")).toBe("alice.md");
  });

  test("auto-increments on collision", () => {
    insertContact({
      id: "a",
      displayName: "Alice",
      role: "contact",
      principalId: null,
      userFile: "alice.md",
      createdAt: Date.now(),
    });
    expect(generateUserFileSlug("Alice")).toBe("alice-2.md");
  });
});

describe("migrateNormalizeUserFileByPrincipal", () => {
  beforeEach(() => {
    resetContactTables();
  });

  test("normalizes split user_file values across sibling contacts", () => {
    const now = Date.now();
    insertContact({
      id: "c1",
      displayName: "sidd",
      role: "guardian",
      principalId: "principal-x",
      userFile: "sidd.md",
      createdAt: now - 1000,
    });
    insertContact({
      id: "c2",
      displayName: "sidd",
      role: "guardian",
      principalId: "principal-x",
      userFile: "sidd-2.md",
      createdAt: now,
    });

    migrateNormalizeUserFileByPrincipal(getDb());

    const rows = fetchUserFilesByPrincipal("principal-x");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.user_file).toBe("sidd.md");
    expect(rows[1]?.user_file).toBe("sidd.md");
  });

  test("propagates a sibling's user_file to NULL rows", () => {
    const now = Date.now();
    insertContact({
      id: "c1",
      displayName: "sidd",
      role: "guardian",
      principalId: "principal-y",
      userFile: "sidd.md",
      createdAt: now - 1000,
    });
    insertContact({
      id: "c2",
      displayName: "sidd",
      role: "guardian",
      principalId: "principal-y",
      userFile: null,
      createdAt: now,
    });

    migrateNormalizeUserFileByPrincipal(getDb());

    const rows = fetchUserFilesByPrincipal("principal-y");
    expect(rows[0]?.user_file).toBe("sidd.md");
    expect(rows[1]?.user_file).toBe("sidd.md");
  });

  test("prefers non-auto-incremented candidate over auto-incremented older row", () => {
    // Older contact has an auto-incremented name, newer has the clean one.
    // Heuristic should pick the clean one regardless of age.
    const now = Date.now();
    insertContact({
      id: "c1",
      displayName: "sidd",
      role: "guardian",
      principalId: "principal-z",
      userFile: "sidd-3.md",
      createdAt: now - 2000,
    });
    insertContact({
      id: "c2",
      displayName: "sidd",
      role: "guardian",
      principalId: "principal-z",
      userFile: "sidd.md",
      createdAt: now,
    });

    migrateNormalizeUserFileByPrincipal(getDb());

    const rows = fetchUserFilesByPrincipal("principal-z");
    expect(rows[0]?.user_file).toBe("sidd.md");
    expect(rows[1]?.user_file).toBe("sidd.md");
  });

  test("leaves untouched when only one contact exists for a principal", () => {
    insertContact({
      id: "solo",
      displayName: "Alone",
      role: "contact",
      principalId: "principal-solo",
      userFile: "alone.md",
      createdAt: Date.now(),
    });

    migrateNormalizeUserFileByPrincipal(getDb());

    const rows = fetchUserFilesByPrincipal("principal-solo");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.user_file).toBe("alone.md");
  });

  test("is idempotent", () => {
    const now = Date.now();
    insertContact({
      id: "c1",
      displayName: "sidd",
      role: "guardian",
      principalId: "principal-i",
      userFile: "sidd.md",
      createdAt: now - 1000,
    });
    insertContact({
      id: "c2",
      displayName: "sidd",
      role: "guardian",
      principalId: "principal-i",
      userFile: "sidd-2.md",
      createdAt: now,
    });

    migrateNormalizeUserFileByPrincipal(getDb());
    migrateNormalizeUserFileByPrincipal(getDb());

    const rows = fetchUserFilesByPrincipal("principal-i");
    for (const row of rows) expect(row.user_file).toBe("sidd.md");
  });
});

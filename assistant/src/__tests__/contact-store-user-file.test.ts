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
      displayName: "Chris",
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
    expect(primary.userFile).toBe("chris.md");

    // Second contact for the same principal on Slack — must inherit the
    // first contact's userFile, NOT auto-increment to chris-2.md.
    const slack = upsertContact({
      displayName: "chris",
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
    expect(slack.userFile).toBe("chris.md");
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
      displayName: "Bob",
      role: "contact",
      channels: [
        {
          type: "slack",
          address: "ubob1",
          externalUserId: "UBOB1",
          externalChatId: "DBOB1",
        },
      ],
    });
    const second = upsertContact({
      displayName: "Bob",
      role: "contact",
      channels: [
        {
          type: "slack",
          address: "ubob2",
          externalUserId: "UBOB2",
          externalChatId: "DBOB2",
        },
      ],
    });
    expect(first.userFile).toBe("bob.md");
    expect(second.userFile).toBe("bob-2.md");
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
      displayName: "chris",
      role: "guardian",
      principalId: "principal-x",
      userFile: "chris.md",
      createdAt: now - 1000,
    });
    insertContact({
      id: "c2",
      displayName: "chris",
      role: "guardian",
      principalId: "principal-x",
      userFile: "chris-2.md",
      createdAt: now,
    });

    migrateNormalizeUserFileByPrincipal(getDb());

    const rows = fetchUserFilesByPrincipal("principal-x");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.user_file).toBe("chris.md");
    expect(rows[1]?.user_file).toBe("chris.md");
  });

  test("propagates a sibling's user_file to NULL rows", () => {
    const now = Date.now();
    insertContact({
      id: "c1",
      displayName: "chris",
      role: "guardian",
      principalId: "principal-y",
      userFile: "chris.md",
      createdAt: now - 1000,
    });
    insertContact({
      id: "c2",
      displayName: "chris",
      role: "guardian",
      principalId: "principal-y",
      userFile: null,
      createdAt: now,
    });

    migrateNormalizeUserFileByPrincipal(getDb());

    const rows = fetchUserFilesByPrincipal("principal-y");
    expect(rows[0]?.user_file).toBe("chris.md");
    expect(rows[1]?.user_file).toBe("chris.md");
  });

  test("prefers non-auto-incremented candidate over auto-incremented older row", () => {
    // Older contact has an auto-incremented name, newer has the clean one.
    // Heuristic should pick the clean one regardless of age.
    const now = Date.now();
    insertContact({
      id: "c1",
      displayName: "chris",
      role: "guardian",
      principalId: "principal-z",
      userFile: "chris-3.md",
      createdAt: now - 2000,
    });
    insertContact({
      id: "c2",
      displayName: "chris",
      role: "guardian",
      principalId: "principal-z",
      userFile: "chris.md",
      createdAt: now,
    });

    migrateNormalizeUserFileByPrincipal(getDb());

    const rows = fetchUserFilesByPrincipal("principal-z");
    expect(rows[0]?.user_file).toBe("chris.md");
    expect(rows[1]?.user_file).toBe("chris.md");
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

  test("does not classify dated-slug filenames as auto-incremented", () => {
    // A display name containing a 4-digit year (e.g. "Dana 2024") produces
    // `dana-2024.md`. The auto-increment suffix only ever appends 1–3 digits
    // (starting at 2), so `dana-2024.md` must be treated as a normal filename
    // and not deprioritized in favor of an older sibling.
    const now = Date.now();
    insertContact({
      id: "c1",
      displayName: "Dana 2024",
      role: "guardian",
      principalId: "principal-dated",
      userFile: "dana-2024.md",
      createdAt: now,
    });
    insertContact({
      id: "c2",
      displayName: "Dana",
      role: "guardian",
      principalId: "principal-dated",
      userFile: "dana.md",
      createdAt: now - 1000,
    });

    migrateNormalizeUserFileByPrincipal(getDb());

    const rows = fetchUserFilesByPrincipal("principal-dated");
    // Neither candidate looks auto-incremented, so tiebreaker is oldest
    // created_at — c2 (`dana.md`) wins. Crucially, `dana-2024.md` was NOT
    // classified as auto-incremented and penalized.
    expect(rows.map((r) => r.user_file).sort()).toEqual(["dana.md", "dana.md"]);
  });

  test("excludes year-like 4-digit tails from the auto-increment class", () => {
    // `-2.md` is auto-increment; `-1999.md` (year) is not.
    const now = Date.now();
    insertContact({
      id: "c1",
      displayName: "Bob 1999",
      role: "guardian",
      principalId: "principal-mixed",
      userFile: "bob-1999.md",
      createdAt: now - 2000,
    });
    insertContact({
      id: "c2",
      displayName: "Bob",
      role: "guardian",
      principalId: "principal-mixed",
      userFile: "bob-2.md",
      createdAt: now - 1000,
    });

    migrateNormalizeUserFileByPrincipal(getDb());

    const rows = fetchUserFilesByPrincipal("principal-mixed");
    // `bob-1999.md` is non-auto-incremented, `bob-2.md` is auto-incremented;
    // the former wins regardless of age.
    for (const row of rows) expect(row.user_file).toBe("bob-1999.md");
  });

  test("classifies 4+ digit counter tails as auto-incremented", () => {
    // `generateUserFileSlug` has an unbounded `for (let i = 2; ; i++)` loop,
    // so a dense slug space can produce 4+ digit counters like `-1000.md`.
    // Those must still be recognized as auto-increments so siblings are
    // normalized to the clean base, not to the counter value.
    const now = Date.now();
    insertContact({
      id: "c1",
      displayName: "Carol",
      role: "guardian",
      principalId: "principal-big",
      userFile: "carol-1000.md",
      createdAt: now - 2000,
    });
    insertContact({
      id: "c2",
      displayName: "Carol",
      role: "guardian",
      principalId: "principal-big",
      userFile: "carol.md",
      createdAt: now,
    });

    migrateNormalizeUserFileByPrincipal(getDb());

    const rows = fetchUserFilesByPrincipal("principal-big");
    // Despite `carol-1000.md` being older, it's auto-incremented, so
    // `carol.md` wins as canonical.
    for (const row of rows) expect(row.user_file).toBe("carol.md");
  });

  test("excludes full date-shaped tails from the auto-increment class", () => {
    // `dana-2025-04-13.md` ends with `-13.md` (which otherwise looks like a
    // small counter), but the preceding `-2025-04` marks the whole tail as a
    // date. Must NOT be classified as auto-incremented.
    const now = Date.now();
    insertContact({
      id: "c1",
      displayName: "Dana 2025 04 13",
      role: "guardian",
      principalId: "principal-datefull",
      userFile: "dana-2025-04-13.md",
      createdAt: now - 2000,
    });
    insertContact({
      id: "c2",
      displayName: "Dana",
      role: "guardian",
      principalId: "principal-datefull",
      userFile: "dana-2.md",
      createdAt: now - 1000,
    });

    migrateNormalizeUserFileByPrincipal(getDb());

    const rows = fetchUserFilesByPrincipal("principal-datefull");
    // `dana-2.md` is auto-incremented; `dana-2025-04-13.md` is a date-shaped
    // slug and wins as canonical.
    for (const row of rows) expect(row.user_file).toBe("dana-2025-04-13.md");
  });

  test("treats year-prefixed single-digit counter slug as auto-incremented", () => {
    // `dana-2025-2.md` is `generateUserFileSlug` output when the base
    // `dana-2025.md` was already taken — it is a collision counter, NOT a
    // date. Counters are emitted without leading zeros (`-2`, `-3`, ...)
    // while ISO date components are always 2 digits (`-02`, `-04`), so
    // single-digit trailing segments mark the tail as a counter.
    const now = Date.now();
    insertContact({
      id: "c1",
      displayName: "Dana 2025",
      role: "guardian",
      principalId: "principal-yc",
      userFile: "dana-2025-2.md",
      createdAt: now - 2000,
    });
    insertContact({
      id: "c2",
      displayName: "Dana 2025",
      role: "guardian",
      principalId: "principal-yc",
      userFile: "dana-2025.md",
      createdAt: now,
    });

    migrateNormalizeUserFileByPrincipal(getDb());

    const rows = fetchUserFilesByPrincipal("principal-yc");
    // Despite being older, `dana-2025-2.md` is auto-incremented, so
    // `dana-2025.md` (the clean base) wins as canonical.
    for (const row of rows) expect(row.user_file).toBe("dana-2025.md");
  });

  test("treats year-prefixed single-digit tail as base slug when display name generates it", () => {
    // Ambiguous filename: `dana-2025-4.md` could be either a collision counter
    // on base `dana-2025.md` OR the direct base slug from display name
    // "Dana 2025 4". The classifier must cross-reference the row's display
    // name — if `generateUserFileSlug`'s pure slug transform maps the name to
    // the filename, treat it as a base slug, not an auto-incremented counter.
    const now = Date.now();
    insertContact({
      id: "c1",
      displayName: "Dana 2025 4",
      role: "guardian",
      principalId: "principal-yb",
      userFile: "dana-2025-4.md",
      createdAt: now,
    });
    insertContact({
      id: "c2",
      displayName: "Dana",
      role: "guardian",
      principalId: "principal-yb",
      userFile: "dana-2.md",
      createdAt: now - 1000,
    });

    migrateNormalizeUserFileByPrincipal(getDb());

    const rows = fetchUserFilesByPrincipal("principal-yb");
    // `dana-2025-4.md` is a legitimate base slug (disambiguated by display
    // name), while `dana-2.md` is auto-incremented. The base slug must win
    // as canonical, otherwise canonical would point at a collision counter.
    for (const row of rows) expect(row.user_file).toBe("dana-2025-4.md");
  });

  test("is idempotent", () => {
    const now = Date.now();
    insertContact({
      id: "c1",
      displayName: "chris",
      role: "guardian",
      principalId: "principal-i",
      userFile: "chris.md",
      createdAt: now - 1000,
    });
    insertContact({
      id: "c2",
      displayName: "chris",
      role: "guardian",
      principalId: "principal-i",
      userFile: "chris-2.md",
      createdAt: now,
    });

    migrateNormalizeUserFileByPrincipal(getDb());
    migrateNormalizeUserFileByPrincipal(getDb());

    const rows = fetchUserFilesByPrincipal("principal-i");
    for (const row of rows) expect(row.user_file).toBe("chris.md");
  });
});

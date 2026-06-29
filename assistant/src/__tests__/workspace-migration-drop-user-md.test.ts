/**
 * Tests for workspace migration `031-drop-user-md`.
 *
 * The migration resolves the guardian contact via a frozen raw-SQL read of
 * the local `contacts`/`contact_channels` tables, backfills a `user_file`
 * slug when missing, migrates any customized `USER.md` into
 * `users/<slug>.md`, and deletes the legacy root `USER.md`.
 *
 * These tests seed the guardian directly in the local DB so the migration
 * is exercised end-to-end against real SQLite — no gateway or mocks.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";

import { getSqlite } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";

await initializeDb();

import { dropUserMdMigration } from "../workspace/migrations/031-drop-user-md.js";

// ── DB seeding helpers ────────────────────────────────────────────

function resetContactTables(): void {
  const sqlite = getSqlite();
  sqlite.run("DELETE FROM contact_channels");
  sqlite.run("DELETE FROM contacts");
}

/** Whether a column exists on a table, via `PRAGMA table_info`. */
function hasColumn(table: string, column: string): boolean {
  const rows = getSqlite()
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all();
  return rows.some((r) => r.name === column);
}

/**
 * The guardian-cleanup path reads the legacy ACL columns `contacts.role` and
 * `contact_channels.status` / `verified_at`, which migration 305 drops from the
 * production schema. Re-add them (pre-drop shape) in the isolated test DB so the
 * migration's `aclColumnsPresent` guard finds them and the cleanup path runs —
 * exactly the historical schema the migration was written against.
 */
function ensureAclColumns(): void {
  const sqlite = getSqlite();
  if (!hasColumn("contacts", "role")) {
    sqlite.run("ALTER TABLE contacts ADD COLUMN role TEXT");
  }
  if (!hasColumn("contact_channels", "status")) {
    sqlite.run("ALTER TABLE contact_channels ADD COLUMN status TEXT");
  }
  if (!hasColumn("contact_channels", "verified_at")) {
    sqlite.run("ALTER TABLE contact_channels ADD COLUMN verified_at INTEGER");
  }
}

/**
 * Insert a guardian contact plus an active channel so the migration's
 * raw-SQL guardian read resolves it. Requires the legacy ACL columns, so
 * it ensures they are present first.
 */
function seedGuardian(input: {
  id: string;
  displayName: string;
  userFile: string | null;
  channelType?: string;
  address?: string;
  verifiedAt?: number;
}): void {
  ensureAclColumns();
  const now = Date.now();
  const sqlite = getSqlite();
  sqlite.run(
    `INSERT INTO contacts (id, display_name, created_at, updated_at, role, user_file, contact_type)
     VALUES (?, ?, ?, ?, 'guardian', ?, 'human')`,
    [input.id, input.displayName, now, now, input.userFile],
  );
  sqlite.run(
    `INSERT INTO contact_channels (id, contact_id, type, address, status, verified_at, created_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?)`,
    [
      `${input.id}-ch`,
      input.id,
      input.channelType ?? "vellum",
      input.address ?? "vellum:self",
      input.verifiedAt ?? now,
      now,
    ],
  );
}

/** Drop the legacy ACL columns the guardian read depends on, if present. */
function dropAclColumns(): void {
  const sqlite = getSqlite();
  if (hasColumn("contacts", "role")) {
    sqlite.run("ALTER TABLE contacts DROP COLUMN role");
  }
  if (hasColumn("contact_channels", "status")) {
    sqlite.run("ALTER TABLE contact_channels DROP COLUMN status");
  }
  if (hasColumn("contact_channels", "verified_at")) {
    sqlite.run("ALTER TABLE contact_channels DROP COLUMN verified_at");
  }
}

function guardianUserFile(id: string): string | null {
  const row = getSqlite()
    .query<
      { user_file: string | null },
      [string]
    >(`SELECT user_file FROM contacts WHERE id = ?`)
    .get(id);
  return row?.user_file ?? null;
}

// ── Test workspace scaffold ───────────────────────────────────────

function workspaceDir(): string {
  const dir = process.env.VELLUM_WORKSPACE_DIR;
  if (!dir) {
    throw new Error(
      "VELLUM_WORKSPACE_DIR should be set by the test preload — aborting",
    );
  }
  return dir;
}

function userMdPath(): string {
  return join(workspaceDir(), "USER.md");
}

function cleanupWorkspaceFiles(): void {
  const dir = workspaceDir();
  for (const p of [join(dir, "USER.md"), join(dir, "users")]) {
    rmSync(p, { recursive: true, force: true });
  }
}

function templateContent(): string {
  return `_ Lines starting with _ are comments - they won't appear in the system prompt

# USER.md

Store details about your user here. Edit freely - build this over time as you learn about them. Don't be pushy about seeking details, but when you learn something, write it down. More context makes you more useful.

- Preferred name/reference:
- Pronouns:
- Locale:
- Work role:
- Goals:
- Hobbies/fun:
- Daily tools:
`;
}

function customizedContent(): string {
  return `_ Lines starting with _ are comments - they won't appear in the system prompt

# USER.md

- Preferred name/reference: Chris
- Pronouns: they/them
- Work role: Engineer
- Daily tools: Vellum, vim, tmux
`;
}

beforeEach(() => {
  resetContactTables();
  cleanupWorkspaceFiles();
  // Most scenarios exercise the guardian-cleanup path, which the migration
  // only enters when the legacy ACL columns are present. Migration 305 drops
  // them from the production schema, so re-add them (pre-drop shape) by default;
  // the dedicated "ACL columns absent" test drops them to cover the skip-path.
  ensureAclColumns();
});

// ── Tests ─────────────────────────────────────────────────────────

describe("workspace migration 031-drop-user-md", () => {
  test("has the correct id and description", () => {
    expect(dropUserMdMigration.id).toBe("031-drop-user-md");
    expect(dropUserMdMigration.description).toContain(
      "Delete legacy workspace-root USER.md",
    );
  });

  test("does not declare retryFailedCheckpoint (no gateway coupling)", () => {
    expect(dropUserMdMigration.retryFailedCheckpoint).toBeUndefined();
  });

  test("fresh install (no guardian, no USER.md) is a no-op", () => {
    dropUserMdMigration.run(workspaceDir());

    expect(existsSync(userMdPath())).toBe(false);
    expect(existsSync(join(workspaceDir(), "users"))).toBe(false);
  });

  test("no guardian with unmodified-template USER.md — deletes it", () => {
    writeFileSync(userMdPath(), templateContent(), "utf-8");

    dropUserMdMigration.run(workspaceDir());

    expect(existsSync(userMdPath())).toBe(false);
  });

  test("no guardian with customized USER.md — preserves it (mirror may be stale)", () => {
    const content = customizedContent();
    writeFileSync(userMdPath(), content, "utf-8");

    dropUserMdMigration.run(workspaceDir());

    // The local guardian mirror can be stale, so a customized profile must
    // not be destroyed when no guardian row resolves.
    expect(existsSync(userMdPath())).toBe(true);
    expect(readFileSync(userMdPath(), "utf-8")).toBe(content);
  });

  test("pre-017 customized USER.md with guardian missing userFile backfills slug and migrates content", () => {
    seedGuardian({ id: "guardian-1", displayName: "Chris", userFile: null });

    const content = customizedContent();
    writeFileSync(userMdPath(), content, "utf-8");

    dropUserMdMigration.run(workspaceDir());

    // Backfill happened: the contact's user_file is now the generated slug.
    expect(guardianUserFile("guardian-1")).toBe("chris.md");

    // Content was migrated into users/chris.md.
    const destPath = join(workspaceDir(), "users", "chris.md");
    expect(existsSync(destPath)).toBe(true);
    expect(readFileSync(destPath, "utf-8")).toBe(content);

    // Legacy USER.md was deleted.
    expect(existsSync(userMdPath())).toBe(false);
  });

  test("post-017 users/<slug>.md already populated, USER.md still on disk as template — does not overwrite dest, deletes USER.md", () => {
    seedGuardian({
      id: "guardian-2",
      displayName: "Chris",
      userFile: "chris.md",
    });

    const usersDir = join(workspaceDir(), "users");
    mkdirSync(usersDir, { recursive: true });
    const destPath = join(usersDir, "chris.md");
    const existingPersona = "# Chris's Profile\n\n- Loves kayaking\n";
    writeFileSync(destPath, existingPersona, "utf-8");

    writeFileSync(userMdPath(), templateContent(), "utf-8");

    dropUserMdMigration.run(workspaceDir());

    // users/chris.md is untouched.
    expect(readFileSync(destPath, "utf-8")).toBe(existingPersona);
    // USER.md is gone.
    expect(existsSync(userMdPath())).toBe(false);
    // No slug backfill necessary.
    expect(guardianUserFile("guardian-2")).toBe("chris.md");
  });

  test("idempotent: second run is a no-op after the first run deleted USER.md", () => {
    seedGuardian({
      id: "guardian-3",
      displayName: "Alice",
      userFile: "alice.md",
    });

    writeFileSync(userMdPath(), customizedContent(), "utf-8");

    dropUserMdMigration.run(workspaceDir());
    expect(existsSync(userMdPath())).toBe(false);
    const destPath = join(workspaceDir(), "users", "alice.md");
    expect(existsSync(destPath)).toBe(true);
    const afterFirst = readFileSync(destPath, "utf-8");

    dropUserMdMigration.run(workspaceDir());
    expect(existsSync(userMdPath())).toBe(false);
    expect(existsSync(destPath)).toBe(true);
    expect(readFileSync(destPath, "utf-8")).toBe(afterFirst);
  });

  test("guardian exists but users/ directory is missing — migration creates the directory", () => {
    seedGuardian({ id: "guardian-4", displayName: "Bob", userFile: "bob.md" });

    writeFileSync(userMdPath(), customizedContent(), "utf-8");
    expect(existsSync(join(workspaceDir(), "users"))).toBe(false);

    dropUserMdMigration.run(workspaceDir());

    expect(existsSync(join(workspaceDir(), "users"))).toBe(true);
    const destPath = join(workspaceDir(), "users", "bob.md");
    expect(existsSync(destPath)).toBe(true);
    expect(readFileSync(destPath, "utf-8")).toBe(customizedContent());
    expect(existsSync(userMdPath())).toBe(false);
  });

  test("falls back to any guardian when no vellum-channel guardian exists", () => {
    seedGuardian({
      id: "guardian-5",
      displayName: "Carol",
      userFile: "carol.md",
      channelType: "telegram",
      address: "carol-tg",
    });

    writeFileSync(userMdPath(), customizedContent(), "utf-8");

    dropUserMdMigration.run(workspaceDir());

    const destPath = join(workspaceDir(), "users", "carol.md");
    expect(existsSync(destPath)).toBe(true);
    expect(readFileSync(destPath, "utf-8")).toBe(customizedContent());
    expect(existsSync(userMdPath())).toBe(false);
  });

  test("prefers vellum-channel guardian over a more-recently-verified other guardian", () => {
    // Older vellum guardian vs newer telegram guardian: vellum wins.
    seedGuardian({
      id: "guardian-vellum",
      displayName: "Vee",
      userFile: "vee.md",
      channelType: "vellum",
      address: "vellum:self",
      verifiedAt: 1_000,
    });
    seedGuardian({
      id: "guardian-tg",
      displayName: "Tom",
      userFile: "tom.md",
      channelType: "telegram",
      address: "tom-tg",
      verifiedAt: 2_000,
    });

    writeFileSync(userMdPath(), customizedContent(), "utf-8");

    dropUserMdMigration.run(workspaceDir());

    expect(existsSync(join(workspaceDir(), "users", "vee.md"))).toBe(true);
    expect(existsSync(join(workspaceDir(), "users", "tom.md"))).toBe(false);
  });

  test("template-shaped USER.md with no destination file — seeds scaffold and deletes USER.md", () => {
    seedGuardian({
      id: "guardian-6",
      displayName: "Dana",
      userFile: "dana.md",
    });

    writeFileSync(userMdPath(), templateContent(), "utf-8");

    dropUserMdMigration.run(workspaceDir());

    expect(existsSync(userMdPath())).toBe(false);

    const destPath = join(workspaceDir(), "users", "dana.md");
    expect(existsSync(destPath)).toBe(true);
    const content = readFileSync(destPath, "utf-8");
    expect(content).toContain("# User Profile");
    expect(content).toContain("Preferred name/reference:");
    expect(content).not.toContain("# USER.md");
  });

  test("down() is a no-op (deletion is irreversible)", () => {
    dropUserMdMigration.down(workspaceDir());
    expect(existsSync(userMdPath())).toBe(false);
  });

  test("ACL columns absent — skips guardian cleanup cleanly and leaves USER.md untouched", () => {
    // Mirror the post-drop assistant-DB schema (migration 305). The migration's
    // `aclColumnsPresent` guard must skip the guardian-dependent cleanup with no
    // throw. Guardian-seeding tests re-add the columns via `ensureAclColumns()`,
    // so dropping them here only affects this scenario.
    const content = customizedContent();
    writeFileSync(userMdPath(), content, "utf-8");

    dropAclColumns();
    try {
      expect(() => dropUserMdMigration.run(workspaceDir())).not.toThrow();
    } finally {
      // Restore schema so a later test that reads these columns directly is
      // unaffected; beforeEach only clears rows, not schema.
      ensureAclColumns();
    }

    // USER.md is left exactly as-is; no users/ scaffold is created.
    expect(existsSync(userMdPath())).toBe(true);
    expect(readFileSync(userMdPath(), "utf-8")).toBe(content);
    expect(existsSync(join(workspaceDir(), "users"))).toBe(false);
  });
});

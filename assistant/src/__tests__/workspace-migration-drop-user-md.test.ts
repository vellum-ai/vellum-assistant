/**
 * Tests for workspace migration `031-drop-user-md`.
 *
 * Validates the five behavioral contracts spelled out in the plan:
 *   1. Fresh install (no guardian) — no-op.
 *   2. Pre-017 customized USER.md, guardian has no userFile — backfill slug,
 *      copy content into users/<slug>.md, delete USER.md.
 *   3. Post-017 state (users/<slug>.md already populated, USER.md still on disk
 *      as template) — migration does NOT overwrite users/<slug>.md, deletes USER.md.
 *   4. Idempotent re-run — running twice has no additional effect.
 *   5. Guardian with missing users/ directory — migration creates the directory.
 *
 * The migration imports `findGuardianForChannel`, `listGuardianChannels`,
 * and `generateUserFileSlug` from `contacts/contact-store.js`, and calls
 * `getDb()` to persist backfilled slugs. These tests stub the contact
 * store and DB layer so no real DB is exercised.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

// ── Mock state ────────────────────────────────────────────────────

interface MockContact {
  id: string;
  displayName: string;
  userFile: string | null;
}

let mockVellumGuardian: {
  contact: MockContact;
  channel: Record<string, unknown>;
} | null = null;
let mockAnyGuardian: {
  contact: MockContact;
  channels: Record<string, unknown>[];
} | null = null;
let mockSlugOverride: ((displayName: string) => string) | null = null;

// Records drizzle `.update(contacts).set({userFile: ...}).where(...).run()` calls.
let updatedUserFiles: Array<{ contactId: string; userFile: string }> = [];

// ── Mock modules (must precede migration import) ──────────────────

mock.module("../contacts/contact-store.js", () => ({
  findGuardianForChannel: (channelType: string) =>
    channelType === "vellum" ? mockVellumGuardian : null,
  listGuardianChannels: () => mockAnyGuardian,
  generateUserFileSlug: (displayName: string) => {
    if (mockSlugOverride) return mockSlugOverride(displayName);
    const base =
      displayName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "user";
    return `${base}.md`;
  },
}));

// Minimal drizzle-compatible stub for the single `update` call in the
// migration. The migration builds:
//   db.update(contacts).set({ userFile: slug }).where(eq(contacts.id, guardian.id)).run();
// The stub captures the payload into `updatedUserFiles` and also mutates
// the active mock guardian in place so downstream reads observe the new slug.
mock.module("../memory/db.js", () => ({
  getDb: () => ({
    update: () => ({
      set: (values: { userFile: string }) => ({
        where: () => ({
          run: () => {
            const guardian =
              mockVellumGuardian?.contact ?? mockAnyGuardian?.contact ?? null;
            if (guardian) {
              guardian.userFile = values.userFile;
              updatedUserFiles.push({
                contactId: guardian.id,
                userFile: values.userFile,
              });
            }
          },
        }),
      }),
    }),
  }),
}));

// drizzle-orm's `eq()` is invoked by the migration; stub it out so we
// don't need the real module loaded for unit tests.
mock.module("drizzle-orm", () => ({
  eq: (_col: unknown, value: unknown) => ({ col: _col, value }),
}));

// Stub the schema import so drizzle operand construction doesn't touch
// the real sqlite schema (which pulls in the DB).
mock.module("../memory/schema/contacts.js", () => ({
  contacts: { id: "id", userFile: "userFile" },
}));

// Import AFTER mocks so the migration binds to the stubs above.
import { dropUserMdMigration } from "../workspace/migrations/031-drop-user-md.js";

// ── Test workspace scaffold ───────────────────────────────────────

let testRoot: string;
let workspaceDir: string;

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

- Preferred name/reference: Sidd
- Pronouns: he/him
- Work role: Engineer
- Daily tools: Vellum, vim, tmux
`;
}

beforeAll(() => {
  testRoot = mkdtempSync(join(tmpdir(), "drop-user-md-test-"));
});

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

beforeEach(() => {
  workspaceDir = mkdtempSync(join(testRoot, "ws-"));
  mockVellumGuardian = null;
  mockAnyGuardian = null;
  mockSlugOverride = null;
  updatedUserFiles = [];
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────────

describe("workspace migration 031-drop-user-md", () => {
  test("has the correct id and description", () => {
    expect(dropUserMdMigration.id).toBe("031-drop-user-md");
    expect(dropUserMdMigration.description).toContain(
      "Delete legacy workspace-root USER.md",
    );
  });

  test("fresh install (no guardian, no USER.md) is a no-op", () => {
    // No guardian stubbed in, no USER.md on disk.
    dropUserMdMigration.run(workspaceDir);

    expect(existsSync(join(workspaceDir, "USER.md"))).toBe(false);
    expect(existsSync(join(workspaceDir, "users"))).toBe(false);
    expect(updatedUserFiles).toEqual([]);
  });

  test("pre-017 customized USER.md with guardian missing userFile backfills slug and migrates content", () => {
    // Guardian exists on the 'vellum' channel but has no userFile.
    mockVellumGuardian = {
      contact: {
        id: "guardian-1",
        displayName: "Sidd",
        userFile: null,
      },
      channel: { type: "vellum" },
    };

    const userMdPath = join(workspaceDir, "USER.md");
    const content = customizedContent();
    writeFileSync(userMdPath, content, "utf-8");

    dropUserMdMigration.run(workspaceDir);

    // Backfill happened: drizzle update was called with the generated slug.
    expect(updatedUserFiles).toHaveLength(1);
    expect(updatedUserFiles[0].contactId).toBe("guardian-1");
    expect(updatedUserFiles[0].userFile).toBe("sidd.md");

    // Content was migrated into users/sidd.md.
    const destPath = join(workspaceDir, "users", "sidd.md");
    expect(existsSync(destPath)).toBe(true);
    expect(readFileSync(destPath, "utf-8")).toBe(content);

    // Legacy USER.md was deleted.
    expect(existsSync(userMdPath)).toBe(false);
  });

  test("post-017 users/<slug>.md already populated, USER.md still on disk as template — does not overwrite dest, deletes USER.md", () => {
    // Guardian already has a userFile from a prior 017 run.
    mockVellumGuardian = {
      contact: {
        id: "guardian-2",
        displayName: "Sidd",
        userFile: "sidd.md",
      },
      channel: { type: "vellum" },
    };

    // Pre-populated persona file (post-017 state).
    const usersDir = join(workspaceDir, "users");
    mkdirSync(usersDir, { recursive: true });
    const destPath = join(usersDir, "sidd.md");
    const existingPersona = "# Sidd's Profile\n\n- Loves kayaking\n";
    writeFileSync(destPath, existingPersona, "utf-8");

    // Leftover template-shape USER.md at workspace root.
    const userMdPath = join(workspaceDir, "USER.md");
    writeFileSync(userMdPath, templateContent(), "utf-8");

    dropUserMdMigration.run(workspaceDir);

    // users/sidd.md is untouched.
    expect(readFileSync(destPath, "utf-8")).toBe(existingPersona);

    // USER.md is gone.
    expect(existsSync(userMdPath)).toBe(false);

    // No slug backfill necessary.
    expect(updatedUserFiles).toEqual([]);
  });

  test("idempotent: second run is a no-op after the first run deleted USER.md", () => {
    mockVellumGuardian = {
      contact: {
        id: "guardian-3",
        displayName: "Alice",
        userFile: "alice.md",
      },
      channel: { type: "vellum" },
    };

    const userMdPath = join(workspaceDir, "USER.md");
    writeFileSync(userMdPath, customizedContent(), "utf-8");

    // First run: migrates content and deletes USER.md.
    dropUserMdMigration.run(workspaceDir);
    expect(existsSync(userMdPath)).toBe(false);
    const destPath = join(workspaceDir, "users", "alice.md");
    expect(existsSync(destPath)).toBe(true);
    const afterFirst = readFileSync(destPath, "utf-8");

    // Second run: no USER.md remains, users/alice.md already has content,
    // so the destination is not rewritten and USER.md is still absent.
    dropUserMdMigration.run(workspaceDir);
    expect(existsSync(userMdPath)).toBe(false);
    expect(existsSync(destPath)).toBe(true);
    expect(readFileSync(destPath, "utf-8")).toBe(afterFirst);
  });

  test("guardian exists but users/ directory is missing — migration creates the directory", () => {
    mockVellumGuardian = {
      contact: {
        id: "guardian-4",
        displayName: "Bob",
        userFile: "bob.md",
      },
      channel: { type: "vellum" },
    };

    // USER.md present but no users/ dir yet.
    const userMdPath = join(workspaceDir, "USER.md");
    writeFileSync(userMdPath, customizedContent(), "utf-8");
    expect(existsSync(join(workspaceDir, "users"))).toBe(false);

    dropUserMdMigration.run(workspaceDir);

    expect(existsSync(join(workspaceDir, "users"))).toBe(true);
    const destPath = join(workspaceDir, "users", "bob.md");
    expect(existsSync(destPath)).toBe(true);
    expect(readFileSync(destPath, "utf-8")).toBe(customizedContent());
    expect(existsSync(userMdPath)).toBe(false);
  });

  // ─── Bonus coverage for edge cases ───────────────────────────────

  test("falls back to listGuardianChannels when no vellum-channel guardian exists", () => {
    mockVellumGuardian = null;
    mockAnyGuardian = {
      contact: {
        id: "guardian-5",
        displayName: "Carol",
        userFile: "carol.md",
      },
      channels: [{ type: "telegram" }],
    };

    const userMdPath = join(workspaceDir, "USER.md");
    writeFileSync(userMdPath, customizedContent(), "utf-8");

    dropUserMdMigration.run(workspaceDir);

    const destPath = join(workspaceDir, "users", "carol.md");
    expect(existsSync(destPath)).toBe(true);
    expect(readFileSync(destPath, "utf-8")).toBe(customizedContent());
    expect(existsSync(userMdPath)).toBe(false);
  });

  test("template-shaped USER.md with no destination file — seeds scaffold and deletes USER.md", () => {
    mockVellumGuardian = {
      contact: {
        id: "guardian-6",
        displayName: "Dana",
        userFile: "dana.md",
      },
      channel: { type: "vellum" },
    };

    const userMdPath = join(workspaceDir, "USER.md");
    writeFileSync(userMdPath, templateContent(), "utf-8");

    dropUserMdMigration.run(workspaceDir);

    // USER.md is gone.
    expect(existsSync(userMdPath)).toBe(false);

    // The destination was scaffolded with the guardian persona template
    // (parity with ensureGuardianPersonaFile for new installs).
    const destPath = join(workspaceDir, "users", "dana.md");
    expect(existsSync(destPath)).toBe(true);
    const content = readFileSync(destPath, "utf-8");
    expect(content).toContain("# User Profile");
    expect(content).toContain("Preferred name/reference:");
    // Not the legacy template header.
    expect(content).not.toContain("# USER.md");
  });

  test("down() is a no-op (deletion is irreversible)", () => {
    // Should not throw.
    dropUserMdMigration.down(workspaceDir);
    expect(existsSync(join(workspaceDir, "USER.md"))).toBe(false);
  });
});

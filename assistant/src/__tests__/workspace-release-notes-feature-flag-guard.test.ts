import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

/**
 * The historical release-note workspace migrations. These appended bulletins
 * to `<workspace>/UPDATES.md`, which a background job processed at daemon
 * startup. That job has been removed — nothing consumes UPDATES.md release
 * notes anymore — so the set below is frozen. Migration files themselves are
 * append-only and must never be deleted (see the migrations AGENTS.md), but
 * no new ones of this shape may be added.
 */
const FROZEN_RELEASE_NOTE_MIGRATIONS = [
  "043-release-notes-latex-rendering.ts",
  "045-release-notes-meet-avatar.ts",
  "049-release-notes-default-sonnet.ts",
  "053-release-notes-acp-codex.ts",
  "055-release-notes-agentic-recall.ts",
  "056-release-notes-inference-profile-reordering.ts",
  "058-release-notes-acp-sessions-ui.ts",
  "063-release-notes-dynamic-model-context.ts",
  "067-release-notes-safe-storage-limits.ts",
  "068-release-notes-local-timezone.ts",
  "078-release-notes-tavily-web-search.ts",
];

function getReleaseNoteMigrationFiles(): string[] {
  const migrationsDir = join(process.cwd(), "src", "workspace", "migrations");
  return readdirSync(migrationsDir)
    .filter((fileName) => /^\d+-release-notes-[a-z0-9-]+\.ts$/.test(fileName))
    .sort();
}

describe("workspace release-note migrations guard", () => {
  test("no new release-note migrations are added", () => {
    const found = getReleaseNoteMigrationFiles();
    const newMigrations = found.filter(
      (fileName) => !FROZEN_RELEASE_NOTE_MIGRATIONS.includes(fileName),
    );

    if (newMigrations.length > 0) {
      const message = [
        "Release-note migrations append to <workspace>/UPDATES.md, but the",
        "background job that processed that file has been removed — nothing",
        "consumes release notes written there. Do not add new release-note",
        "migrations until a replacement surfacing mechanism is designed.",
        "",
        "New release-note migrations found:",
        ...newMigrations.map((fileName) => `  - ${fileName}`),
      ].join("\n");

      expect(newMigrations, message).toEqual([]);
    }
  });

  test("frozen release-note migrations are never deleted", () => {
    // Migrations are append-only: even though their bulletins are no longer
    // processed, deleting an entry breaks the sequential migration chain on
    // existing installs.
    const found = getReleaseNoteMigrationFiles();
    for (const fileName of FROZEN_RELEASE_NOTE_MIGRATIONS) {
      expect(found).toContain(fileName);
    }
  });
});

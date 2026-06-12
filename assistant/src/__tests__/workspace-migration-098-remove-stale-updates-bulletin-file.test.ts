import {
  existsSync,
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
  test,
} from "bun:test";

import { releaseNotesLatexRenderingMigration } from "../workspace/migrations/043-release-notes-latex-rendering.js";
import { releaseNotesMeetAvatarMigration } from "../workspace/migrations/045-release-notes-meet-avatar.js";
import { releaseNotesDefaultSonnetMigration } from "../workspace/migrations/049-release-notes-default-sonnet.js";
import { releaseNotesAcpCodexMigration } from "../workspace/migrations/053-release-notes-acp-codex.js";
import { releaseNotesAgenticRecallMigration } from "../workspace/migrations/055-release-notes-agentic-recall.js";
import { releaseNotesInferenceProfileReorderingMigration } from "../workspace/migrations/056-release-notes-inference-profile-reordering.js";
import { releaseNotesAcpSessionsUiMigration } from "../workspace/migrations/058-release-notes-acp-sessions-ui.js";
import { releaseNotesDynamicModelContextMigration } from "../workspace/migrations/063-release-notes-dynamic-model-context.js";
import { releaseNotesLocalTimezoneMigration } from "../workspace/migrations/068-release-notes-local-timezone.js";
import { dropDeprecatedSecretDetectionKeysMigration } from "../workspace/migrations/074-drop-deprecated-secret-detection-keys.js";
import { releaseNotesTavilyWebSearchMigration } from "../workspace/migrations/078-release-notes-tavily-web-search.js";
import { removeStaleUpdatesBulletinFileMigration } from "../workspace/migrations/098-remove-stale-updates-bulletin-file.js";

/**
 * The real historical migrations that appended static release-note blocks to
 * UPDATES.md. Running them (instead of fabricating block text) keeps this
 * test honest: if the duplicated block constants inside migration 098 ever
 * drift from the source migrations, the exactness sweep below fails.
 */
const STATIC_NOTE_MIGRATIONS = [
  releaseNotesLatexRenderingMigration,
  releaseNotesMeetAvatarMigration,
  releaseNotesDefaultSonnetMigration,
  releaseNotesAcpCodexMigration,
  releaseNotesAgenticRecallMigration,
  releaseNotesInferenceProfileReorderingMigration,
  releaseNotesAcpSessionsUiMigration,
  releaseNotesDynamicModelContextMigration,
  releaseNotesLocalTimezoneMigration,
  releaseNotesTavilyWebSearchMigration,
];

const QUARANTINE_CONTENT = `## Config was reset to defaults

Your \`config.json\` was unreadable at 2026-01-01T00:00:00.000Z and couldn't be
parsed as JSON.

<!-- config-quarantine:config.json.corrupt-2026-01-01T00-00-00-000Z.json -->
`;

let testRoot: string;
let workspaceDir: string;

beforeAll(() => {
  testRoot = mkdtempSync(join(tmpdir(), "migration-098-remove-updates-"));
});

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

beforeEach(() => {
  workspaceDir = mkdtempSync(join(testRoot, "ws-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

function updatesPath(): string {
  return join(workspaceDir, "UPDATES.md");
}

describe("098-remove-stale-updates-bulletin-file", () => {
  test("deletes UPDATES.md containing only release notes", () => {
    releaseNotesLatexRenderingMigration.run(workspaceDir);
    releaseNotesTavilyWebSearchMigration.run(workspaceDir);
    expect(existsSync(updatesPath())).toBe(true);

    removeStaleUpdatesBulletinFileMigration.run(workspaceDir);

    expect(existsSync(updatesPath())).toBe(false);
  });

  test("exactness sweep: strips every historical block, including 074's dynamic notice", () => {
    for (const migration of STATIC_NOTE_MIGRATIONS) {
      migration.run(workspaceDir);
    }
    // 074 only writes its notice when the old config had a "block" or
    // "prompt" secretDetection.action.
    writeFileSync(
      join(workspaceDir, "config.json"),
      JSON.stringify({ secretDetection: { action: "block" } }),
      "utf-8",
    );
    dropDeprecatedSecretDetectionKeysMigration.run(workspaceDir);
    expect(readFileSync(updatesPath(), "utf-8")).toContain(
      "074-drop-deprecated-secret-detection-keys",
    );

    removeStaleUpdatesBulletinFileMigration.run(workspaceDir);

    expect(existsSync(updatesPath())).toBe(false);
  });

  test("no-ops when UPDATES.md is absent", () => {
    expect(() =>
      removeStaleUpdatesBulletinFileMigration.run(workspaceDir),
    ).not.toThrow();
    expect(existsSync(updatesPath())).toBe(false);
  });

  test("preserves user-authored content mixed with release notes", () => {
    writeFileSync(updatesPath(), "# My own notes\n\nKeep me.\n", "utf-8");
    releaseNotesTavilyWebSearchMigration.run(workspaceDir);
    const userTail = "\nAlso keep this trailing user note.\n";
    writeFileSync(
      updatesPath(),
      readFileSync(updatesPath(), "utf-8") + userTail,
      "utf-8",
    );

    removeStaleUpdatesBulletinFileMigration.run(workspaceDir);

    expect(existsSync(updatesPath())).toBe(true);
    const remaining = readFileSync(updatesPath(), "utf-8");
    expect(remaining).toContain("# My own notes");
    expect(remaining).toContain("Also keep this trailing user note.");
    expect(remaining).not.toContain("release-note-id:078");
  });

  test("preserves a file without release-note markers (user-repurposed)", () => {
    const userContent = "# My own notes\n\nThe user repurposed this file.\n";
    writeFileSync(updatesPath(), userContent, "utf-8");

    removeStaleUpdatesBulletinFileMigration.run(workspaceDir);

    expect(existsSync(updatesPath())).toBe(true);
    expect(readFileSync(updatesPath(), "utf-8")).toBe(userContent);
  });

  test("preserves a hand-edited block whose text no longer matches", () => {
    releaseNotesTavilyWebSearchMigration.run(workspaceDir);
    const edited = readFileSync(updatesPath(), "utf-8").replace(
      "Tavily is now available",
      "Tavily is now available (edited by hand)",
    );
    writeFileSync(updatesPath(), edited, "utf-8");

    removeStaleUpdatesBulletinFileMigration.run(workspaceDir);

    expect(existsSync(updatesPath())).toBe(true);
    expect(readFileSync(updatesPath(), "utf-8")).toContain("(edited by hand)");
  });

  test("preserves a config-quarantine note while stripping release notes", () => {
    releaseNotesTavilyWebSearchMigration.run(workspaceDir);
    writeFileSync(
      updatesPath(),
      readFileSync(updatesPath(), "utf-8") + "\n" + QUARANTINE_CONTENT,
      "utf-8",
    );

    removeStaleUpdatesBulletinFileMigration.run(workspaceDir);

    expect(existsSync(updatesPath())).toBe(true);
    const remaining = readFileSync(updatesPath(), "utf-8");
    expect(remaining).toContain("## Config was reset to defaults");
    expect(remaining).toContain("<!-- config-quarantine:");
    expect(remaining).not.toContain("release-note-id:078");
  });

  test("is idempotent", () => {
    releaseNotesTavilyWebSearchMigration.run(workspaceDir);

    removeStaleUpdatesBulletinFileMigration.run(workspaceDir);
    removeStaleUpdatesBulletinFileMigration.run(workspaceDir);

    expect(existsSync(updatesPath())).toBe(false);

    // And idempotent on preserved content too.
    const userContent = "# Mine\n";
    writeFileSync(updatesPath(), userContent, "utf-8");
    removeStaleUpdatesBulletinFileMigration.run(workspaceDir);
    removeStaleUpdatesBulletinFileMigration.run(workspaceDir);
    expect(readFileSync(updatesPath(), "utf-8")).toBe(userContent);
  });
});

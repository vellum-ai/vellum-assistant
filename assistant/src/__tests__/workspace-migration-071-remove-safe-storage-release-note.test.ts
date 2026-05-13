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

import { removeSafeStorageReleaseNoteMigration } from "../workspace/migrations/071-remove-safe-storage-release-note.js";

const MIGRATION_ID = "071-remove-safe-storage-release-note";
const SAFE_STORAGE_MARKER =
  "<!-- release-note-id:067-release-notes-safe-storage-limits -->";
const LATER_MARKER =
  "<!-- release-note-id:068-release-notes-local-timezone -->";

const SAFE_STORAGE_RELEASE_NOTE = `${SAFE_STORAGE_MARKER}
## Safe storage limits

A new storage protection mode is available behind the safe-storage-limits
rollout flag. When enabled, the assistant watches workspace disk usage and
enters cleanup mode if the volume reaches the critical 95% threshold.

In cleanup mode, background processes pause and remote messages, including
trusted-contact messages, are blocked until the guardian frees enough space or
explicitly overrides the lock. The macOS app now shows a storage cleanup banner
that must be acknowledged before cleanup chat continues, then keeps a status
banner visible while cleanup mode is active.
`;

let testRoot: string;
let workspaceDir: string;

beforeAll(() => {
  testRoot = mkdtempSync(join(tmpdir(), "migration-071-remove-safe-storage-"));
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

describe("workspace migration 071-remove-safe-storage-release-note", () => {
  test("has the correct id and description", () => {
    expect(removeSafeStorageReleaseNoteMigration.id).toBe(MIGRATION_ID);
    expect(removeSafeStorageReleaseNoteMigration.description).toContain(
      "safe storage release note",
    );
  });

  test("missing UPDATES.md is a no-op", () => {
    expect(existsSync(updatesPath())).toBe(false);

    removeSafeStorageReleaseNoteMigration.run(workspaceDir);

    expect(existsSync(updatesPath())).toBe(false);
  });

  test("removes UPDATES.md when it only contains the safe-storage bulletin", () => {
    writeFileSync(updatesPath(), SAFE_STORAGE_RELEASE_NOTE, "utf-8");

    removeSafeStorageReleaseNoteMigration.run(workspaceDir);

    expect(existsSync(updatesPath())).toBe(false);
  });

  test("preserves prior unrelated release notes when removing the safe-storage block", () => {
    const prior = `<!-- release-note-id:066-earlier-note -->
## Earlier note

This note should stay.
`;
    writeFileSync(
      updatesPath(),
      `${prior}\n${SAFE_STORAGE_RELEASE_NOTE}`,
      "utf-8",
    );

    removeSafeStorageReleaseNoteMigration.run(workspaceDir);

    const content = readFileSync(updatesPath(), "utf-8");
    expect(content).toContain("## Earlier note");
    expect(content).toContain("This note should stay.");
    expect(content).not.toContain(SAFE_STORAGE_MARKER);
    expect(content).not.toContain("Safe storage limits");
  });

  test("preserves a later release-note block after safe storage", () => {
    const later = `${LATER_MARKER}
## Local timezone grounding

This later note should stay.
`;
    writeFileSync(
      updatesPath(),
      `${SAFE_STORAGE_RELEASE_NOTE}\n${later}`,
      "utf-8",
    );

    removeSafeStorageReleaseNoteMigration.run(workspaceDir);

    const content = readFileSync(updatesPath(), "utf-8");
    expect(content.startsWith(LATER_MARKER)).toBe(true);
    expect(content).toContain("## Local timezone grounding");
    expect(content).toContain("This later note should stay.");
    expect(content).not.toContain(SAFE_STORAGE_MARKER);
    expect(content).not.toContain("Safe storage limits");
  });

  test("fallback preserves a later release-note block after a partial safe-storage block", () => {
    const partialSafeStorage = `${SAFE_STORAGE_MARKER}
## Safe storage limits

Partially written note.
`;
    const later = `${LATER_MARKER}
## Local timezone grounding

This later note should stay.
`;
    writeFileSync(updatesPath(), `${partialSafeStorage}\n${later}`, "utf-8");

    removeSafeStorageReleaseNoteMigration.run(workspaceDir);

    const content = readFileSync(updatesPath(), "utf-8");
    expect(content.startsWith(LATER_MARKER)).toBe(true);
    expect(content).toContain("## Local timezone grounding");
    expect(content).not.toContain(SAFE_STORAGE_MARKER);
    expect(content).not.toContain("Partially written note.");
  });

  test("content without the safe-storage marker is byte-identical", () => {
    const original =
      "## Existing note\r\n\r\nNo safe storage marker appears here.\r\n";
    writeFileSync(updatesPath(), original, "utf-8");

    removeSafeStorageReleaseNoteMigration.run(workspaceDir);

    expect(readFileSync(updatesPath(), "utf-8")).toBe(original);
  });

  test("preserves CRLF in unrelated content when removing the safe-storage block", () => {
    const prior =
      "<!-- release-note-id:066-earlier-note -->\r\n## Earlier note\r\n\r\nThis note should keep CRLF.\r\n";
    writeFileSync(
      updatesPath(),
      `${prior}\r\n${SAFE_STORAGE_RELEASE_NOTE}`,
      "utf-8",
    );

    removeSafeStorageReleaseNoteMigration.run(workspaceDir);

    expect(readFileSync(updatesPath(), "utf-8")).toBe(prior);
  });

  test("running twice is idempotent", () => {
    const prior = `<!-- release-note-id:066-earlier-note -->
## Earlier note

This note should stay.
`;
    const later = `${LATER_MARKER}
## Local timezone grounding

This later note should stay.
`;
    writeFileSync(
      updatesPath(),
      `${prior}\n${SAFE_STORAGE_RELEASE_NOTE}\n${later}`,
      "utf-8",
    );

    removeSafeStorageReleaseNoteMigration.run(workspaceDir);
    const afterFirst = readFileSync(updatesPath(), "utf-8");

    removeSafeStorageReleaseNoteMigration.run(workspaceDir);
    const afterSecond = readFileSync(updatesPath(), "utf-8");

    expect(afterSecond).toBe(afterFirst);
    expect(afterSecond).toContain("## Earlier note");
    expect(afterSecond).toContain("## Local timezone grounding");
    expect(afterSecond).not.toContain(SAFE_STORAGE_MARKER);
  });
});

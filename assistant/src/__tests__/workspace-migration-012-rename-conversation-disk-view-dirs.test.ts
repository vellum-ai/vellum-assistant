import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { renameConversationDiskViewDirsMigration } from "../workspace/migrations/012-rename-conversation-disk-view-dirs.js";

function freshWorkspace(): { workspaceDir: string; conversationsDir: string } {
  const workspaceDir = mkdtempSync(
    join(tmpdir(), `vellum-migration-012-test-${Date.now()}-`),
  );
  const conversationsDir = join(workspaceDir, "conversations");
  mkdirSync(conversationsDir, { recursive: true });
  return { workspaceDir, conversationsDir };
}

function legacyConversationDirName(
  conversationId: string,
  createdAtMs: number,
): string {
  return `${conversationId}_${new Date(createdAtMs).toISOString().replace(/:/g, "-")}`;
}

describe("012-rename-conversation-disk-view-dirs migration", () => {
  test("renames legacy conversation directories to timestamp-first names", () => {
    const { workspaceDir, conversationsDir } = freshWorkspace();
    try {
      const createdAt = Date.parse("2026-03-18T14:23:00.000Z");
      const legacyName = legacyConversationDirName("conv-123", createdAt);
      const legacyDir = join(conversationsDir, legacyName);
      mkdirSync(legacyDir, { recursive: true });
      writeFileSync(join(legacyDir, "meta.json"), "{\"ok\":true}\n", "utf-8");

      renameConversationDiskViewDirsMigration.run(workspaceDir);

      const newName = `2026-03-18T14-23-00.000Z_conv-123`;
      const newDir = join(conversationsDir, newName);
      expect(existsSync(legacyDir)).toBe(false);
      expect(existsSync(newDir)).toBe(true);
      expect(readFileSync(join(newDir, "meta.json"), "utf-8")).toContain(
        "\"ok\":true",
      );
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("is idempotent and ignores non-matching entries", () => {
    const { workspaceDir, conversationsDir } = freshWorkspace();
    try {
      const createdAt = Date.parse("2026-03-18T15:00:00.000Z");
      const legacyName = legacyConversationDirName("conv-456", createdAt);
      mkdirSync(join(conversationsDir, legacyName), { recursive: true });
      mkdirSync(join(conversationsDir, "already-new"), { recursive: true });
      mkdirSync(join(conversationsDir, "random-folder"), { recursive: true });

      renameConversationDiskViewDirsMigration.run(workspaceDir);
      renameConversationDiskViewDirsMigration.run(workspaceDir);

      const names = readdirSync(conversationsDir).sort();
      expect(names).toContain("2026-03-18T15-00-00.000Z_conv-456");
      expect(names).toContain("already-new");
      expect(names).toContain("random-folder");
      expect(names).not.toContain(legacyName);
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
});

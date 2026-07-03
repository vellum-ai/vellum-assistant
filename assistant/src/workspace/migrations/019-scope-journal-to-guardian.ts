import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

export const scopeJournalToGuardianMigration: WorkspaceMigration = {
  id: "019-scope-journal-to-guardian",
  description:
    "Move root journal entries into per-user subdirectory for guardian",

  run(workspaceDir: string): void {
    const journalDir = join(workspaceDir, "journal");
    if (!existsSync(journalDir)) return;

    // Find .md files in the root journal directory (not in subdirs)
    let entries: string[];
    try {
      entries = readdirSync(journalDir);
    } catch {
      return;
    }
    const mdFiles = entries.filter((f) => {
      if (!f.endsWith(".md") || f.toLowerCase() === "readme.md") return false;
      try {
        return statSync(join(journalDir, f)).isFile();
      } catch {
        return false;
      }
    });
    if (mdFiles.length === 0) return;

    // Scope under the canonical `guardian` slug — the runtime resolver falls
    // back to it, so no assistant-DB lookup is needed.
    const destDir = join(journalDir, "guardian");
    mkdirSync(destDir, { recursive: true });
    for (const f of mdFiles) {
      const src = join(journalDir, f);
      const dest = join(destDir, f);
      if (!existsSync(dest)) {
        renameSync(src, dest);
      }
    }
  },

  down(workspaceDir: string): void {
    const journalDir = join(workspaceDir, "journal");
    if (!existsSync(journalDir)) return;
    let entries: string[];
    try {
      entries = readdirSync(journalDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const subdir = join(journalDir, entry);
      try {
        if (!statSync(subdir).isDirectory()) continue;
      } catch {
        continue;
      }
      for (const f of readdirSync(subdir)) {
        if (!f.endsWith(".md")) continue;
        const dest = join(journalDir, f);
        if (!existsSync(dest)) {
          renameSync(join(subdir, f), dest);
        }
      }
      try {
        rmdirSync(subdir);
      } catch {
        // not empty — leave it
      }
    }
  },
};

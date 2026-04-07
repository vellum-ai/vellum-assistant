import { existsSync, mkdirSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

const INDEX_TEMPLATE = `_ Lines starting with _ are comments - they won't appear in the injected context

# Knowledge Base

**Remember aggressively.** When you learn ANY fact — a preference, a name, a date, a habit, a plan, an opinion — call \`remember\` immediately. Don't filter, don't judge importance. Remembering too much costs nothing. Forgetting something that mattered costs trust.

## Always Loaded
- essentials.md — Core facts, patterns, and biographical info
- threads.md — Active commitments, follow-ups, and projects in progress
- buffer.md — Inbox of recently learned facts (filed periodically)
- _autoinject.md — Controls which files are loaded into every conversation

## Topics
`;

const ESSENTIALS_TEMPLATE = `_ Lines starting with _ are comments - they won't appear in the injected context

# Essentials

_ The most important facts — things you'd be embarrassed to forget.
_ This file is always loaded into every conversation. Keep it focused.
_ Promote facts here from topic files when they come up constantly.
_ Demote facts to topic files when they stop being essential.
`;

const THREADS_TEMPLATE = `_ Lines starting with _ are comments - they won't appear in the injected context

# Active Threads

_ Commitments, follow-ups, and projects in progress.
_ This file is always loaded into every conversation.
_ Remove items when they're completed or no longer relevant.
`;

export const seedPkbMigration: WorkspaceMigration = {
  id: "029-seed-pkb",
  description: "Create pkb/ knowledge base directory with seed files",

  down(workspaceDir: string): void {
    // Best-effort: only remove empty directories. Never delete user content.
    const pkbDir = join(workspaceDir, "pkb");
    if (!existsSync(pkbDir)) return;

    try {
      // Try removing subdirectories first, then the root. rmdirSync fails
      // on non-empty directories, which is exactly what we want.
      for (const sub of ["archive"]) {
        try {
          rmdirSync(join(pkbDir, sub));
        } catch {
          // Non-empty or doesn't exist — skip
        }
      }
      rmdirSync(pkbDir);
    } catch {
      // Non-empty — leave it alone
    }
  },

  run(workspaceDir: string): void {
    const pkbDir = join(workspaceDir, "pkb");
    mkdirSync(pkbDir, { recursive: true });
    mkdirSync(join(pkbDir, "archive"), { recursive: true });

    // Seed files only if they don't already exist (idempotent)
    const seeds: Array<[string, string]> = [
      ["INDEX.md", INDEX_TEMPLATE],
      ["essentials.md", ESSENTIALS_TEMPLATE],
      ["threads.md", THREADS_TEMPLATE],
      ["buffer.md", ""],
    ];

    for (const [filename, content] of seeds) {
      const filePath = join(pkbDir, filename);
      if (!existsSync(filePath)) {
        writeFileSync(filePath, content, "utf-8");
      }
    }
  },
};

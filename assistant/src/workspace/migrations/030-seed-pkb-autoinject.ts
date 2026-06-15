import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

const AUTOINJECT_TEMPLATE = `_ Lines starting with _ are comments - they won't appear in the injected context
_ List one PKB filename per line. These files are loaded into every conversation.
_ Remove a line to stop autoinjecting that file. Add new filenames to inject more.

INDEX.md
essentials.md
threads.md
buffer.md
`;

const INDEX_ENTRY =
  "- _autoinject.md — Controls which files are loaded into every conversation";

export const seedPkbAutoinjectMigration: WorkspaceMigration = {
  id: "030-seed-pkb-autoinject",
  description: "Seed pkb/_autoinject.md for configurable PKB autoinjection",

  run(workspaceDir: string): void {
    const pkbDir = join(workspaceDir, "pkb");
    if (!existsSync(pkbDir)) return;

    // Seed _autoinject.md if it doesn't already exist
    const autoinjectPath = join(pkbDir, "_autoinject.md");
    if (!existsSync(autoinjectPath)) {
      writeFileSync(autoinjectPath, AUTOINJECT_TEMPLATE, "utf-8");
    }

    // Append _autoinject.md entry to INDEX.md if not already present
    const indexPath = join(pkbDir, "INDEX.md");
    if (existsSync(indexPath)) {
      try {
        const indexContent = readFileSync(indexPath, "utf-8");
        if (!indexContent.includes("_autoinject.md")) {
          // Insert after the last "Always Loaded" entry (buffer.md line)
          const bufferLine = "- buffer.md";
          const bufferIdx = indexContent.indexOf(bufferLine);
          if (bufferIdx !== -1) {
            const endOfBufferLine = indexContent.indexOf("\n", bufferIdx);
            const insertAt =
              endOfBufferLine === -1 ? indexContent.length : endOfBufferLine;
            const updated =
              indexContent.slice(0, insertAt) +
              "\n" +
              INDEX_ENTRY +
              indexContent.slice(insertAt);
            writeFileSync(indexPath, updated, "utf-8");
          }
        }
      } catch {
        // INDEX.md unreadable — skip
      }
    }
  },

  down(workspaceDir: string): void {
    const autoinjectPath = join(workspaceDir, "pkb", "_autoinject.md");
    if (!existsSync(autoinjectPath)) return;

    try {
      const content = readFileSync(autoinjectPath, "utf-8");
      // Only delete if content matches the template (preserve user edits)
      if (content === AUTOINJECT_TEMPLATE) {
        unlinkSync(autoinjectPath);
      }
    } catch {
      // Unreadable — leave it alone
    }
  },
};

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

// Original bar seeded by migration 029 at its initial release.
const ORIGINAL_BAR = `**Remember aggressively.** When you learn ANY fact — a preference, a name, a date, a habit, a plan, an opinion — call \`remember\` immediately. Don't filter, don't judge importance. Remembering too much costs nothing. Forgetting something that mattered costs trust.`;

// Bar introduced in PR #25532 (an in-place edit of migration 029). Users who
// installed while that edit was live had this version seeded. Recognized here
// so this migration can normalize both populations to NEW_BAR.
const POST_25532_BAR = `**Remember aggressively.** Capture anything concrete about your user — preferences, names, dates, habits, plans, opinions, health details, commitments. Default to remembering; only skip obvious noise (small talk, hypotheticals). Don't judge importance — filing decides that later. Call \`remember\` immediately, multiple times per conversation. Remembering too much costs nothing. Forgetting something that mattered costs trust.`;

const NEW_BAR = `**Remember aggressively.** Capture anything concrete about your user — preferences, names, dates, habits, plans, opinions, health details, commitments. Default to remembering; only skip obvious noise (small talk, hypotheticals). Don't judge importance — filing decides that later. Call \`remember\` immediately, multiple times per conversation. Remembering too much costs nothing. Forgetting something that mattered costs trust.`;

export const updatePkbIndexBarMigration: WorkspaceMigration = {
  id: "036-update-pkb-index-bar",
  description:
    "Normalize pkb/INDEX.md 'Remember aggressively' bar across both variants previously seeded by migration 029",

  down(_workspaceDir: string): void {
    // No-op: don't revert user-editable file content on rollback.
  },

  run(workspaceDir: string): void {
    const indexPath = join(workspaceDir, "pkb", "INDEX.md");
    if (!existsSync(indexPath)) return;

    const current = readFileSync(indexPath, "utf-8");

    for (const bar of [ORIGINAL_BAR, POST_25532_BAR]) {
      if (current.includes(bar)) {
        const updated = current.replace(bar, NEW_BAR);
        if (updated !== current) {
          writeFileSync(indexPath, updated, "utf-8");
        }
        return;
      }
    }
    // User-edited or unknown variant — leave alone.
  },
};

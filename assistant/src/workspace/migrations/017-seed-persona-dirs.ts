import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
} from "node:fs";
import { join } from "node:path";

import { desc, eq } from "drizzle-orm";

import { generateUserFileSlug } from "../../contacts/contact-store.js";
import { getDb } from "../../memory/db.js";
import { contacts } from "../../memory/schema/contacts.js";
import type { WorkspaceMigration } from "./types.js";

// ── Inlined helpers ───────────────────────────────────────────────
//
// Per migrations/AGENTS.md, migrations must be self-contained. The
// helpers below are duplicated inline (rather than imported from
// `util/strip-comment-lines.js` or `prompts/system-prompt.js`) so this
// migration does not regress if those modules change — or, in the case
// of the legacy `templates/USER.md` template file, disappear entirely.
// Migration 031-drop-user-md deletes that template file, and previously
// this migration's unmodified-template check silently started copying
// bare scaffolds once the template was gone.

/**
 * Strip lines starting with `_` (comment convention for prompt .md files)
 * and collapse any resulting consecutive blank lines. Copied from
 * `util/strip-comment-lines.ts` to keep this migration self-contained.
 */
function stripCommentLines(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n");
  let openFenceChar: string | null = null;
  const filtered = normalized.split("\n").filter((line) => {
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const char = fenceMatch[1][0];
      if (!openFenceChar) {
        openFenceChar = char;
      } else if (char === openFenceChar) {
        openFenceChar = null;
      }
    }
    if (openFenceChar) return true;
    return !line.trimStart().startsWith("_");
  });
  return filtered
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Frozen snapshot of the legacy `templates/USER.md` contents that
 * shipped at the time this migration was authored. Used to detect
 * unmodified template installs so we don't copy a useless scaffold
 * into `users/<slug>.md`. The template file itself is deleted by
 * migration 031, so we cannot read it from disk here.
 */
const LEGACY_USER_MD_TEMPLATE = `_ Lines starting with _ are comments - they won't appear in the system prompt

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

const LEGACY_USER_MD_TEMPLATE_STRIPPED = stripCommentLines(
  LEGACY_USER_MD_TEMPLATE,
);

export const seedPersonaDirsMigration: WorkspaceMigration = {
  id: "017-seed-persona-dirs",
  description:
    "Create users/ and channels/ persona directories and migrate customized USER.md",

  down(workspaceDir: string): void {
    // Remove the seeded persona directories only if they are empty.
    // We don't delete user-created content — only clean up the empty
    // directories that the forward migration created.
    const usersDir = join(workspaceDir, "users");
    const channelsDir = join(workspaceDir, "channels");

    for (const dir of [usersDir, channelsDir]) {
      if (!existsSync(dir)) continue;
      try {
        const entries = readdirSync(dir);
        if (entries.length === 0) {
          rmdirSync(dir);
        }
      } catch {
        // Best-effort: skip if we can't read or remove
      }
    }
  },

  run(workspaceDir: string): void {
    // Create persona directories
    mkdirSync(join(workspaceDir, "users"), { recursive: true });
    mkdirSync(join(workspaceDir, "channels"), { recursive: true });

    // Check if USER.md exists and has been customized
    const userMdPath = join(workspaceDir, "USER.md");
    if (!existsSync(userMdPath)) return;

    const rawContent = readFileSync(userMdPath, "utf-8");
    const content = stripCommentLines(rawContent);
    if (!content) return;

    // Skip if the content is the unmodified legacy template. We compare
    // against an inlined snapshot rather than reading the bundled
    // template from disk, since migration 031 deletes that template file.
    if (content === LEGACY_USER_MD_TEMPLATE_STRIPPED) return;

    // Determine destination filename based on guardian contact
    let destFilename = "guardian.md";
    try {
      const db = getDb();
      const guardian = db
        .select()
        .from(contacts)
        .where(eq(contacts.role, "guardian"))
        .orderBy(desc(contacts.createdAt))
        .limit(1)
        .get();

      if (guardian) {
        if (guardian.userFile) {
          destFilename = guardian.userFile;
        } else {
          const slug = generateUserFileSlug(guardian.displayName);
          db.update(contacts)
            .set({ userFile: slug })
            .where(eq(contacts.id, guardian.id))
            .run();
          destFilename = slug;
        }
      }
    } catch {
      // DB might not be initialized yet — fall back to guardian.md
    }

    const destPath = join(workspaceDir, "users", destFilename);
    if (!existsSync(destPath)) {
      copyFileSync(userMdPath, destPath);
    }
  },
};

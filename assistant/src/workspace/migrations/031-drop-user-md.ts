import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { Database } from "bun:sqlite";

import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger("workspace-migration-031-drop-user-md");

// ── Inlined helpers ───────────────────────────────────────────────
//
// AGENTS.md requires each migration to be self-contained: it may import
// only `./types.js`, `./utils.js`, the logger, and runtime built-ins.
// The helpers below (including the guardian DB read and the userFile
// slug) are inlined so this migration does not regress if the modules
// they originate from change later.

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
 * Frozen snapshot of the legacy `templates/USER.md` contents shipped
 * before this migration deletes it. Used to detect unmodified template
 * installs so we don't copy a useless scaffold into `users/<slug>.md`.
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

/**
 * Current `GUARDIAN_PERSONA_TEMPLATE` text from `prompts/persona-resolver.ts`,
 * duplicated here for the same self-containment reason. Written when we
 * need to seed an empty `users/<slug>.md` so new installs stay consistent
 * with `ensureGuardianPersonaFile`.
 */
const GUARDIAN_PERSONA_TEMPLATE = `_ Lines starting with _ are comments - they won't appear in the system prompt

# User Profile

Store details about your user here. Edit freely - build this over time as you learn about them. Don't be pushy about seeking details, but when you learn something, write it down. More context makes you more useful.

- Preferred name/reference:
- Pronouns:
- Locale:
- Work role:
- Goals:
- Hobbies/fun:
- Daily tools:
`;

function isLegacyTemplateContent(raw: string): boolean {
  const stripped = stripCommentLines(raw);
  if (stripped.length === 0) return true;
  return stripped === LEGACY_USER_MD_TEMPLATE_STRIPPED;
}

function destFileIsMissingOrEmpty(destPath: string): boolean {
  if (!existsSync(destPath)) return true;
  try {
    const raw = readFileSync(destPath, "utf-8");
    return stripCommentLines(raw).length === 0;
  } catch {
    return true;
  }
}

function isValidSlug(slug: string): boolean {
  return basename(slug) === slug && slug !== "." && slug !== "..";
}

/** Names of the columns present on a table, via `PRAGMA table_info`. */
function tableColumns(db: Database, table: string): Set<string> {
  const rows = db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all();
  return new Set(rows.map((r) => r.name));
}

/**
 * The guardian read below depends on the legacy ACL columns
 * `contacts.role` and `contact_channels.status` / `verified_at`. Guardian ACL
 * is gateway-owned, so these columns may be absent from the assistant DB; this
 * one-time cleanup is skipped when they are.
 */
function aclColumnsPresent(db: Database): boolean {
  const contactCols = tableColumns(db, "contacts");
  const channelCols = tableColumns(db, "contact_channels");
  return (
    contactCols.has("role") &&
    channelCols.has("status") &&
    channelCols.has("verified_at")
  );
}

/**
 * Strip LIKE metacharacters so the prefix match runs literally. SQLite has
 * no default LIKE escape character, so strip rather than escape. Inlined
 * from `contacts/contact-store.ts`.
 */
function escapeLike(value: string): string {
  return value.replace(/%/g, "").replace(/_/g, "");
}

/** Pure slug transform applied to a display name. */
function computeUserFileBaseSlug(displayName: string): string {
  return (
    displayName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 100) || "user"
  );
}

/**
 * Generate a collision-free `users/<slug>.md` filename for a display name,
 * inlined verbatim from `contacts/contact-store.ts` to keep this migration
 * self-contained. Produces "alice.md", "alice-2.md", etc.
 */
function generateUserFileSlug(db: Database, displayName: string): string {
  const slug = computeUserFileBaseSlug(displayName);

  const rows = db
    .query<{ user_file: string | null }, [string]>(
      `SELECT user_file FROM contacts WHERE user_file LIKE ?`,
    )
    .all(`${escapeLike(slug)}%`);

  const taken = new Set(rows.map((r) => r.user_file?.toLowerCase()));

  const base = `${slug}.md`;
  if (!taken.has(base)) return base;

  for (let i = 2; ; i++) {
    const candidate = `${slug}-${i}.md`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Delete the legacy `USER.md` at the workspace root after migrating
 * any customized content into `users/<slug>.md`.
 *
 * Handles these relevant states:
 *   1. No local guardian → preserve a customized `USER.md` (the local
 *      mirror can be stale, so a customized profile may still belong to a
 *      real guardian); delete only the unmodified template/empty file.
 *   2. Pre-017 customized `USER.md`, guardian has no `userFile` →
 *      backfill the slug, copy `USER.md` → `users/<slug>.md`, delete `USER.md`.
 *   3. Post-017 state where `users/<slug>.md` already has content →
 *      do NOT overwrite; delete lingering `USER.md` regardless of content.
 *   4. Missing `users/<slug>.md` after guardian is resolved → seed a bare
 *      `GUARDIAN_PERSONA_TEMPLATE` scaffold so downstream readers have a file.
 */
interface GuardianRow {
  id: string;
  display_name: string;
  user_file: string | null;
}

export const dropUserMdMigration: WorkspaceMigration = {
  id: "031-drop-user-md",
  description:
    "Delete legacy workspace-root USER.md after migrating content to users/<slug>.md",

  run(workspaceDir: string): void {
    const userMdPath = join(workspaceDir, "USER.md");

    const dbPath = join(workspaceDir, "data", "db", "assistant.db");
    if (!existsSync(dbPath)) return; // DB not created yet — defer cleanup.

    let db: Database;
    try {
      db = new Database(dbPath);
    } catch (err) {
      log.warn({ err }, "Cannot open assistant DB; deferring USER.md cleanup");
      return;
    }

    try {
      if (!aclColumnsPresent(db)) return; // ACL columns dropped — cleanup is a no-op.

      // Resolve the guardian contact from the local DB. Prefer the
      // vellum-channel binding (the canonical native guardian); fall back to
      // whichever guardian has the most recently verified active channel.
      let guardianRow: GuardianRow | null;
      try {
        guardianRow =
          db
            .query<GuardianRow, []>(
              `SELECT c.id AS id, c.display_name AS display_name, c.user_file AS user_file
                 FROM contacts c JOIN contact_channels cc ON cc.contact_id = c.id
                WHERE c.role = 'guardian' AND cc.status = 'active'
                ORDER BY (cc.type = 'vellum') DESC, cc.verified_at DESC
                LIMIT 1`,
            )
            .get() ?? null;
      } catch (err) {
        // DB not ready or query failed — leave USER.md alone. The next
        // startup after DB init tries again.
        log.warn(
          { err },
          "Failed to resolve guardian contact; deferring USER.md cleanup",
        );
        return;
      }

      if (!guardianRow) {
        // No local guardian. The mirror can be stale (the gateway mirrors
        // best-effort), so a customized USER.md may still belong to a real
        // guardian — preserve it. Only delete the unmodified template/empty
        // stale file.
        if (existsSync(userMdPath)) {
          let isStaleTemplate = false;
          try {
            isStaleTemplate =
              !statSync(userMdPath).isFile() ||
              isLegacyTemplateContent(readFileSync(userMdPath, "utf-8"));
          } catch (err) {
            log.warn(
              { err, path: userMdPath },
              "Cannot read USER.md with no guardian; leaving in place",
            );
            return;
          }

          if (!isStaleTemplate) {
            log.info(
              { path: userMdPath },
              "Preserving customized USER.md with no local guardian",
            );
            return;
          }

          try {
            unlinkSync(userMdPath);
            log.info(
              { path: userMdPath },
              "Deleting stale template USER.md with no guardian",
            );
          } catch (err) {
            log.warn(
              { err, path: userMdPath },
              "Failed to delete stale USER.md; leaving in place",
            );
          }
        }
        return;
      }

      const guardian = {
        id: guardianRow.id,
        displayName: guardianRow.display_name,
        userFile: guardianRow.user_file ?? null,
      };

      // Backfill a userFile slug on the guardian contact if one isn't set.
      if (!guardian.userFile) {
        try {
          const slug = generateUserFileSlug(db, guardian.displayName);
          db.run("UPDATE contacts SET user_file = ? WHERE id = ?", [
            slug,
            guardian.id,
          ]);
          guardian.userFile = slug;
          log.info(
            { contactId: guardian.id, slug },
            "Backfilled missing guardian.userFile",
          );
        } catch (err) {
          log.warn(
            { err, contactId: guardian.id },
            "Failed to backfill guardian.userFile; deferring USER.md cleanup",
          );
          return;
        }
      }

      const userFile = guardian.userFile;
      if (!userFile || !isValidSlug(userFile)) {
        log.warn(
          { userFile },
          "Guardian userFile is missing or not a safe basename; deferring USER.md cleanup",
        );
        return;
      }

      const usersDir = join(workspaceDir, "users");
      mkdirSync(usersDir, { recursive: true });

      const destPath = join(usersDir, userFile);

      // Read USER.md if it exists and classify its content.
      let userMdRaw: string | null = null;
      let userMdIsCustomized = false;
      if (existsSync(userMdPath)) {
        try {
          // Guard against USER.md being a directory (hostile state).
          if (statSync(userMdPath).isFile()) {
            userMdRaw = readFileSync(userMdPath, "utf-8");
            userMdIsCustomized = !isLegacyTemplateContent(userMdRaw);
          }
        } catch (err) {
          log.warn(
            { err, path: userMdPath },
            "Failed to read USER.md; treating as unreadable",
          );
        }
      }

      // Copy customized USER.md content into users/<slug>.md when the
      // destination is missing or effectively empty. Post-017 installs
      // that already populated users/<slug>.md are left untouched.
      if (
        userMdIsCustomized &&
        userMdRaw !== null &&
        destFileIsMissingOrEmpty(destPath)
      ) {
        try {
          copyFileSync(userMdPath, destPath);
          log.info(
            { src: userMdPath, dest: destPath },
            "Copied customized USER.md content into users/<slug>.md",
          );
        } catch (err) {
          log.warn(
            { err, src: userMdPath, dest: destPath },
            "Failed to copy USER.md; deferring USER.md cleanup",
          );
          return;
        }
      }

      // Seed the guardian persona scaffold when the destination file
      // still doesn't exist (e.g. no USER.md and no post-017 content).
      // This keeps parity with `ensureGuardianPersonaFile` for new
      // installs so downstream readers always find a file.
      if (!existsSync(destPath)) {
        try {
          writeFileSync(destPath, GUARDIAN_PERSONA_TEMPLATE, "utf-8");
          log.info(
            { dest: destPath },
            "Seeded guardian persona scaffold at users/<slug>.md",
          );
        } catch (err) {
          log.warn(
            { err, dest: destPath },
            "Failed to seed guardian persona scaffold; continuing with USER.md deletion",
          );
        }
      }

      // Finally, delete the legacy USER.md if it still exists — template or
      // customized, it has no remaining consumer.
      if (existsSync(userMdPath)) {
        try {
          unlinkSync(userMdPath);
          log.info({ path: userMdPath }, "Deleted legacy workspace USER.md");
        } catch (err) {
          log.warn(
            { err, path: userMdPath },
            "Failed to delete legacy USER.md",
          );
        }
      }
    } finally {
      db.close();
    }
  },

  down(_workspaceDir: string): void {
    // No-op: deletion is irreversible. Any content that was present in
    // `USER.md` was copied into `users/<slug>.md` during `run()`, so
    // rolling back this migration cannot restore the original file.
    // Downstream migrations (if any) read from `users/<slug>.md`.
  },
};

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

import { generateUserFileSlug } from "../../contacts/contact-store.js";
import { getSqlite } from "../../memory/db-connection.js";
import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger("workspace-migration-031-drop-user-md");

// ── Inlined helpers ───────────────────────────────────────────────
//
// Per AGENTS.md, migrations should minimize cross-module imports so
// they remain stable as code around them evolves. The helpers below
// are duplicated inline (rather than imported from
// `util/strip-comment-lines.js` and `prompts/system-prompt.js`) so
// this migration does not regress if those modules change later.

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

/**
 * Delete the legacy `USER.md` at the workspace root after migrating
 * any customized content into `users/<slug>.md`.
 *
 * Handles four relevant states:
 *   1. Fresh install, no guardian → no-op (nothing to migrate yet).
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

    // Resolve the guardian contact from the local DB. Prefer the
    // vellum-channel binding (the canonical native guardian); fall back to
    // whichever guardian has the most recently verified active channel.
    let guardianRow: GuardianRow | null;
    try {
      guardianRow =
        getSqlite()
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
      // startup after DB init will try again.
      log.warn(
        { err },
        "Failed to resolve guardian contact; deferring USER.md cleanup",
      );
      return;
    }

    if (!guardianRow) {
      // Fresh install or pre-onboarding. If a stale USER.md somehow remains
      // on disk (e.g. leftover from an older build), best-effort remove it so
      // future first runs are clean.
      if (existsSync(userMdPath)) {
        try {
          unlinkSync(userMdPath);
          log.info(
            { path: userMdPath },
            "Deleted stale pre-onboarding USER.md with no guardian",
          );
        } catch (err) {
          log.warn(
            { err, path: userMdPath },
            "Failed to delete pre-onboarding USER.md; leaving in place",
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
        const slug = generateUserFileSlug(guardian.displayName);
        getSqlite().run("UPDATE contacts SET user_file = ? WHERE id = ?", [
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
        log.warn({ err, path: userMdPath }, "Failed to delete legacy USER.md");
      }
    }
  },

  down(_workspaceDir: string): void {
    // No-op: deletion is irreversible. Any content that was present in
    // `USER.md` was copied into `users/<slug>.md` during `run()`, so
    // rolling back this migration cannot restore the original file.
    // Downstream migrations (if any) read from `users/<slug>.md`.
  },
};

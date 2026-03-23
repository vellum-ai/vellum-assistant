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
import {
  isTemplateContent,
  stripCommentLines,
} from "../../prompts/system-prompt.js";
import type { WorkspaceMigration } from "./types.js";

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

    // Skip if the content is the unmodified template
    if (isTemplateContent(content, "USER.md")) return;

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

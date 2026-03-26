/**
 * Workspace migration 020: Rename OAuth skill directories and update SKILLS.md
 * index entries to match the new `<domain>-oauth-app-setup` naming convention.
 *
 * Also removes deleted skills (collaborative-oauth-flow, oauth-setup) that
 * were superseded by vellum-oauth-integrations.
 *
 * Idempotent: safe to re-run after interruption at any point.
 */

import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

// ---------------------------------------------------------------------------
// Rename map: old directory name -> new directory name
// ---------------------------------------------------------------------------

const RENAMES: [oldName: string, newName: string][] = [
  ["google-oauth-applescript", "google-oauth-app-setup"],
  ["airtable-oauth-setup", "airtable-oauth-app-setup"],
  ["asana-oauth-setup", "asana-oauth-app-setup"],
  ["discord-oauth-setup", "discord-oauth-app-setup"],
  ["dropbox-oauth-setup", "dropbox-oauth-app-setup"],
  ["figma-oauth-setup", "figma-oauth-app-setup"],
  ["github-oauth-setup", "github-oauth-app-setup"],
  ["hubspot-oauth-setup", "hubspot-oauth-app-setup"],
  ["linear-oauth-setup", "linear-oauth-app-setup"],
  ["notion-oauth-setup", "notion-oauth-app-setup"],
  ["spotify-oauth-setup", "spotify-oauth-app-setup"],
  ["todoist-oauth-setup", "todoist-oauth-app-setup"],
  ["twitter-oauth-setup", "twitter-oauth-app-setup"],
];

/** Skills that were deleted and should be removed from the workspace. */
const DELETED_SKILLS = ["collaborative-oauth-flow", "oauth-setup"];

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

export const renameOauthSkillDirsMigration: WorkspaceMigration = {
  id: "020-rename-oauth-skill-dirs",
  description:
    "Rename OAuth skill directories to <domain>-oauth-app-setup convention and remove deleted skills",

  run(workspaceDir: string): void {
    const skillsDir = join(workspaceDir, "skills");
    if (!existsSync(skillsDir)) return;

    // 1. Rename skill directories
    for (const [oldName, newName] of RENAMES) {
      const oldDir = join(skillsDir, oldName);
      const newDir = join(skillsDir, newName);
      if (existsSync(oldDir) && !existsSync(newDir)) {
        renameSync(oldDir, newDir);
      }
    }

    // 2. Remove deleted skill directories
    for (const name of DELETED_SKILLS) {
      const dir = join(skillsDir, name);
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    // 3. Update SKILLS.md index entries
    const indexPath = join(skillsDir, "SKILLS.md");
    if (existsSync(indexPath)) {
      let content = readFileSync(indexPath, "utf-8");
      for (const [oldName, newName] of RENAMES) {
        content = content.replaceAll(oldName, newName);
      }
      for (const name of DELETED_SKILLS) {
        // Remove lines referencing deleted skills (e.g., "- collaborative-oauth-flow\n")
        content = content.replace(
          new RegExp(`^[\\t ]*-\\s*${name}\\s*\\n?`, "gm"),
          "",
        );
      }
      writeFileSync(indexPath, content, "utf-8");
    }
  },

  down(workspaceDir: string): void {
    const skillsDir = join(workspaceDir, "skills");
    if (!existsSync(skillsDir)) return;

    // Reverse renames
    for (const [oldName, newName] of RENAMES) {
      const oldDir = join(skillsDir, oldName);
      const newDir = join(skillsDir, newName);
      if (existsSync(newDir) && !existsSync(oldDir)) {
        renameSync(newDir, oldDir);
      }
    }

    // Reverse SKILLS.md index entries
    const indexPath = join(skillsDir, "SKILLS.md");
    if (existsSync(indexPath)) {
      let content = readFileSync(indexPath, "utf-8");
      for (const [oldName, newName] of RENAMES) {
        content = content.replaceAll(newName, oldName);
      }
      writeFileSync(indexPath, content, "utf-8");
    }

    // Note: deleted skills cannot be restored by down() since they were
    // removed from the repo. Users would need to reinstall them.
  },
};

/**
 * Workspace migration 025: Remove standalone OAuth app setup skill directories
 * and their SKILLS.md entries from user workspaces.
 *
 * These skills have been consolidated into vellum-oauth-integrations and are
 * no longer shipped as standalone skills.
 *
 * Idempotent: safe to re-run after interruption at any point.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

// ---------------------------------------------------------------------------
// Skills to remove
// ---------------------------------------------------------------------------

const DELETED_SKILLS = [
  "airtable-oauth-app-setup",
  "asana-oauth-app-setup",
  "discord-oauth-app-setup",
  "dropbox-oauth-app-setup",
  "figma-oauth-app-setup",
  "github-oauth-app-setup",
  "google-oauth-app-setup",
  "hubspot-oauth-app-setup",
  "linear-oauth-app-setup",
  "notion-oauth-app-setup",
  "spotify-oauth-app-setup",
  "todoist-oauth-app-setup",
  "twitter-oauth-app-setup",
];

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

export const removeOauthAppSetupSkillsMigration: WorkspaceMigration = {
  id: "025-remove-oauth-app-setup-skills",
  description:
    "Remove standalone OAuth app setup skill directories consolidated into vellum-oauth-integrations",

  run(workspaceDir: string): void {
    const skillsDir = join(workspaceDir, "skills");
    if (!existsSync(skillsDir)) return;

    // 1. Remove skill directories
    for (const name of DELETED_SKILLS) {
      const dir = join(skillsDir, name);
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    // 2. Update SKILLS.md to remove entries referencing deleted skills
    const indexPath = join(skillsDir, "SKILLS.md");
    if (existsSync(indexPath)) {
      let content = readFileSync(indexPath, "utf-8");
      for (const name of DELETED_SKILLS) {
        content = content.replace(
          new RegExp(`^[\\t ]*-\\s*${name}\\s*\\n?`, "gm"),
          "",
        );
      }
      writeFileSync(indexPath, content, "utf-8");
    }
  },

  down(_workspaceDir: string): void {
    // Deleted skills cannot be restored since they have been removed from the
    // repo. Users would need to reinstall the `vellum-oauth-integrations`
    // skill to regain the consolidated OAuth setup functionality.
  },
};

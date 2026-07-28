import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { MigrationRunContext, WorkspaceMigration } from "./types.js";

// The onboarding bullets seeded by 069-seed-onboarding-threads. Inlined here
// (not imported) to keep this migration self-contained and decoupled from 069.

// The personality-authoring bullet, dropped entirely. Includes the trailing
// newline so the whole line is removed without leaving a blank line behind.
const PERSONALITY_BULLET =
  "- Figure out what kind of personality would best mesh with your user. Figure out who you are and what your voice should be. Your choice should be DISTINCT and have CHARACTER. Once you've figured this out, rewrite SOUL.md and IDENTITY.md in your own voice to define who you are.\n";

// The avatar bullet, retargeted at the vellum-avatar skill.
const OLD_AVATAR_BULLET =
  "- Work with your user to set a custom avatar for yourself. This task is done once data/avatar/avatar-image.png exists.";
const NEW_AVATAR_BULLET =
  "- Work with your user to set a custom AI generated avatar for yourself using the `vellum-avatar` skill. This task is done once data/avatar/avatar-image.png exists.";

export const reviseOnboardingThreadsMigration: WorkspaceMigration = {
  id: "120-revise-onboarding-threads",
  description:
    "Revise memory/threads.md onboarding bullets for brand new assistants: drop the personality-authoring bullet and point the avatar bullet at the vellum-avatar skill",

  run(workspaceDir: string, ctx?: MigrationRunContext): void {
    // Only rewrite onboarding tasks for newly-created workspaces. An existing
    // assistant whose user has edited threads.md must not have its content
    // rewritten on upgrade. When invoked without a context (e.g. from older
    // callers), default to the safe path and skip — the runner always supplies
    // one in production.
    if (!ctx?.isNewWorkspace) return;
    const filePath = join(workspaceDir, "memory", "threads.md");
    if (!existsSync(filePath)) return;
    const original = readFileSync(filePath, "utf-8");
    const updated = original
      .replace(PERSONALITY_BULLET, "")
      .replace(OLD_AVATAR_BULLET, NEW_AVATAR_BULLET);
    // Idempotent: if neither known bullet is present (already revised, or the
    // user edited them away), there is nothing to do.
    if (updated === original) return;
    writeFileSync(filePath, updated, "utf-8");
  },

  down(_workspaceDir: string): void {
    // Forward-only: never rewrite user-visible memory content on rollback.
  },
};

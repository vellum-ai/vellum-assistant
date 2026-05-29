import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { MigrationRunContext, WorkspaceMigration } from "./types.js";

// The exact onboarding bullet seeded by 069-seed-onboarding-threads for the
// assistant-migration step. Inlined here (not imported) to keep this migration
// self-contained and decoupled from 069.
const OLD_BULLET =
  "- Ask your user if they use ChatGPT, Claude or another AI tool and offer to help them import memories from there.";

// The tightened replacement: help-first, an early light one-time offer, naming
// the common prior assistants. Keeps the literal "ChatGPT, Claude" substring.
const NEW_BULLET =
  "- After helping with the user's first real task, offer early — at the first natural opening — to port their context, memories, prompts, skills, or workflows from a prior assistant (ChatGPT, Claude, OpenClaw, Hermes, or another tool). Keep it a light one-time offer, not a push; if they decline, drop it.";

export const retightenMigrationOnboardingThreadMigration: WorkspaceMigration = {
  id: "091-retighten-migration-onboarding-thread",
  description:
    "Retighten the assistant-migration onboarding bullet in memory/threads.md for brand new assistants",

  run(workspaceDir: string, ctx?: MigrationRunContext): void {
    // Only rewrite onboarding tasks for newly-created workspaces. An existing
    // assistant whose user has edited threads.md must not have its content
    // rewritten on upgrade. When invoked without a context (e.g. from older
    // callers), default to the safe path and skip — the runner always supplies
    // one in production.
    if (!ctx?.isNewWorkspace) return;
    const filePath = join(workspaceDir, "memory", "threads.md");
    if (!existsSync(filePath)) return;
    const content = readFileSync(filePath, "utf-8");
    // Idempotent: if the old bullet is absent (already replaced, or the user
    // edited it away), there is nothing to do.
    if (!content.includes(OLD_BULLET)) return;
    writeFileSync(filePath, content.replace(OLD_BULLET, NEW_BULLET), "utf-8");
  },

  down(_workspaceDir: string): void {
    // Forward-only: never rewrite user-visible memory content on rollback.
  },
};

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { MigrationRunContext, WorkspaceMigration } from "./types.js";

const ONBOARDING_THREADS = `- Figure out what kind of personality would best mesh with your user. Figure out who you are and what your voice should be. Your choice should be DISTINCT and have CHARACTER. Once you've figured this out, rewrite SOUL.md and IDENTITY.md in your own voice to define who you are.
- Work with your user to set a custom avatar for yourself. This task is done once data/avatar/avatar-image.png exists.
- Ask your user if they use ChatGPT, Claude or another AI tool and offer to help them import memories from there.
- Suggest connecting to available messaging services like Slack or Telegram
`;

export const seedOnboardingThreadsMigration: WorkspaceMigration = {
  id: "069-seed-onboarding-threads",
  description:
    "Seed memory/threads.md with onboarding tasks for brand new assistants",

  run(workspaceDir: string, ctx?: MigrationRunContext): void {
    // Only seed onboarding tasks for newly-created workspaces. An existing
    // assistant whose user has cleaned up threads.md must not have onboarding
    // bullets injected into static memory context on upgrade. When invoked
    // without a context (e.g. from older callers), default to the safe path
    // and skip — the runner always supplies one in production.
    if (!ctx?.isNewWorkspace) return;
    const filePath = join(workspaceDir, "memory", "threads.md");
    if (!existsSync(filePath)) return;
    const current = readFileSync(filePath, "utf-8");
    if (current.trim().length > 0) return;
    writeFileSync(filePath, ONBOARDING_THREADS, "utf-8");
  },

  down(_workspaceDir: string): void {
    // Forward-only: never delete user-visible memory content on rollback.
  },
};

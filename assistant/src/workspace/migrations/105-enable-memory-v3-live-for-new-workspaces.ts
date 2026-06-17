import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { MigrationRunContext, WorkspaceMigration } from "./types.js";

/**
 * Switch brand-new assistants onto memory-v3 (the live injected memory source)
 * at creation by persisting `memory.v3.live = true`.
 *
 * The schema default is `false`, so existing assistants keep running v2 on
 * upgrade — this migration writes the value only for freshly-created
 * workspaces. The value gates v3 via `isMemoryV3Live`; existing assistants are
 * switched on deliberately, never automatically. Covers every surface (local,
 * Docker, managed) uniformly because all run workspace migrations on first boot.
 */
export const enableMemoryV3LiveForNewWorkspacesMigration: WorkspaceMigration = {
  id: "105-enable-memory-v3-live-for-new-workspaces",
  description:
    "Persist memory.v3.live=true for brand-new workspaces so new assistants run memory-v3 from creation",

  run(workspaceDir: string, ctx?: MigrationRunContext): void {
    // Only switch new assistants on. Existing workspaces fall through to the
    // schema default (false) and keep running v2 until enabled explicitly.
    // Without a context (older callers) treat the workspace as existing.
    if (!ctx?.isNewWorkspace) return;

    const configPath = join(workspaceDir, "config.json");

    // A fresh workspace may have no config.json yet (schema defaults are
    // applied in memory at load); create one so the live default persists.
    let config: Record<string, unknown> = {};
    if (existsSync(configPath)) {
      try {
        const raw = JSON.parse(readFileSync(configPath, "utf-8"));
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
        config = raw as Record<string, unknown>;
      } catch {
        return;
      }
    }

    if (config.memory === undefined) config.memory = {};
    const memory = config.memory;
    if (!memory || typeof memory !== "object" || Array.isArray(memory)) return;
    const memoryConfig = memory as Record<string, unknown>;

    if (memoryConfig.v3 === undefined) memoryConfig.v3 = {};
    const v3 = memoryConfig.v3;
    if (!v3 || typeof v3 !== "object" || Array.isArray(v3)) return;
    const v3Config = v3 as Record<string, unknown>;

    // Respect an explicit value already present (idempotent re-runs, or a
    // hatch-time override that set it deliberately).
    if ("live" in v3Config) return;

    v3Config.live = true;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },

  down(_workspaceDir: string): void {
    // Forward-only: cannot distinguish a user's explicit choice from this seed.
  },
};

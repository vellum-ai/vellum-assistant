import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

/**
 * Convert `memory.cleanup.llmRequestLogRetentionMs: 0` to `null`.
 *
 * Under the old semantics `0` meant "keep forever" (never prune). The new
 * semantics use `null` for "keep forever" and `0` for "prune immediately".
 * Without this migration, users who previously set the retention to "keep
 * forever" would be silently switched to "prune everything on next cleanup
 * run" after upgrading.
 */
export const llmLogRetentionZeroToNullMigration: WorkspaceMigration = {
  id: "031-llm-log-retention-zero-to-null",
  description:
    "Convert llmRequestLogRetentionMs: 0 (old 'keep forever') to null (new 'keep forever')",
  run(workspaceDir: string): void {
    const configPath = join(workspaceDir, "config.json");
    if (!existsSync(configPath)) return;

    let config: Record<string, unknown>;
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
      config = raw as Record<string, unknown>;
    } catch {
      return; // Malformed config — skip
    }

    const memory = config.memory;
    if (!memory || typeof memory !== "object" || Array.isArray(memory)) return;
    const memoryObj = memory as Record<string, unknown>;

    const cleanup = memoryObj.cleanup;
    if (!cleanup || typeof cleanup !== "object" || Array.isArray(cleanup))
      return;
    const cleanupObj = cleanup as Record<string, unknown>;

    if (cleanupObj.llmRequestLogRetentionMs !== 0) return;

    cleanupObj.llmRequestLogRetentionMs = null;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },
  down(workspaceDir: string): void {
    const configPath = join(workspaceDir, "config.json");
    if (!existsSync(configPath)) return;

    let config: Record<string, unknown>;
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
      config = raw as Record<string, unknown>;
    } catch {
      return;
    }

    const memory = config.memory;
    if (!memory || typeof memory !== "object" || Array.isArray(memory)) return;
    const memoryObj = memory as Record<string, unknown>;

    const cleanup = memoryObj.cleanup;
    if (!cleanup || typeof cleanup !== "object" || Array.isArray(cleanup))
      return;
    const cleanupObj = cleanup as Record<string, unknown>;

    if (cleanupObj.llmRequestLogRetentionMs !== null) return;

    cleanupObj.llmRequestLogRetentionMs = 0;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },
};

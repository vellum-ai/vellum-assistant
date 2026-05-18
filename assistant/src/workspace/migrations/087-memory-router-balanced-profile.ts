import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

// Set callSites.memoryRouter to { profile: "balanced" }, dropping the explicit
// model and 1M context-window override seeded by 077 — accepts page-index
// truncation on workspaces larger than the balanced profile's context window.
export const memoryRouterBalancedProfileMigration: WorkspaceMigration = {
  id: "087-memory-router-balanced-profile",
  description:
    "Set callSites.memoryRouter to { profile: 'balanced' }, dropping the seeded model and contextWindow override",
  run(workspaceDir: string): void {
    if (process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH) return;

    const configPath = join(workspaceDir, "config.json");
    const configExisted = existsSync(configPath);

    let config: Record<string, unknown> = {};
    if (configExisted) {
      try {
        const raw = JSON.parse(readFileSync(configPath, "utf-8"));
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
        config = raw as Record<string, unknown>;
      } catch {
        return;
      }
    }

    const llm = readObject(config.llm) ?? {};
    const callSites = readObject(llm.callSites) ?? {};
    const existing = readObject(callSites.memoryRouter);

    if (
      existing !== null &&
      Object.keys(existing).length === 1 &&
      existing.profile === "balanced"
    ) {
      return;
    }

    callSites.memoryRouter = { profile: "balanced" };
    llm.callSites = callSites;
    config.llm = llm;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },
  down(_workspaceDir: string): void {
    // Forward-only.
  },
};

function readObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

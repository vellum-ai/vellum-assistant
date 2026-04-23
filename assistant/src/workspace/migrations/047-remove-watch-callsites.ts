import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

/**
 * Remove `watchCommentary` and `watchSummary` entries from
 * `llm.callSites` in existing config files. These call-sites were seeded
 * by migration 040 but the screen-watch feature has been removed, so the
 * keys are no longer valid members of the `LLMCallSiteEnum` and would
 * trigger repeated validation warnings if left on disk.
 */
export const removeWatchCallsitesMigration: WorkspaceMigration = {
  id: "047-remove-watch-callsites",
  description:
    "Remove watchCommentary and watchSummary from llm.callSites (screen-watch removed)",
  run(workspaceDir: string): void {
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

    const llm = config.llm;
    if (!llm || typeof llm !== "object" || Array.isArray(llm)) return;

    const callSites = (llm as Record<string, unknown>).callSites;
    if (!callSites || typeof callSites !== "object" || Array.isArray(callSites))
      return;

    const sites = callSites as Record<string, unknown>;
    let mutated = false;

    for (const key of ["watchCommentary", "watchSummary"]) {
      if (key in sites) {
        delete sites[key];
        mutated = true;
      }
    }

    if (!mutated) return;

    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },
  down(_workspaceDir: string): void {
    // no-op — keys are obsolete
  },
};

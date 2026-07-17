import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

/**
 * Remove `analyzeConversation` from `llm.callSites` and the top-level
 * `analysis` block from existing config files. The analyze-conversation
 * feature has been removed, so `analyzeConversation` is no longer a valid
 * member of the `LLMCallSiteEnum` and would trigger repeated validation
 * warnings if left on disk; the `analysis` block is unknown to the config
 * schema and would linger as dead cruft.
 */
export const removeAnalyzeConversationConfigMigration: WorkspaceMigration = {
  id: "129-remove-analyze-conversation-config",
  description:
    "Remove llm.callSites.analyzeConversation and the analysis config block (analyze-conversation feature removed)",
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

    let mutated = false;

    if ("analysis" in config) {
      delete config.analysis;
      mutated = true;
    }

    const llm = config.llm;
    if (llm && typeof llm === "object" && !Array.isArray(llm)) {
      const callSites = (llm as Record<string, unknown>).callSites;
      if (
        callSites &&
        typeof callSites === "object" &&
        !Array.isArray(callSites) &&
        "analyzeConversation" in callSites
      ) {
        delete (callSites as Record<string, unknown>).analyzeConversation;
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

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

const SEEDED_MAIN_AGENT_MODEL = "claude-opus-4-7";
const SEEDED_MAIN_AGENT_MAX_TOKENS = 32000;
const DEFAULT_MANAGED_PROFILE = "balanced";

export const unwindMainAgentOpusSeedMigration: WorkspaceMigration = {
  id: "064-unwind-main-agent-opus-seed",
  description:
    "Remove seeded mainAgent Opus model override and default activeProfile to balanced",
  run(workspaceDir: string): void {
    const configPath = join(workspaceDir, "config.json");

    let config: Record<string, unknown>;
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
      config = raw as Record<string, unknown>;
    } catch {
      return;
    }

    const llm = readObject(config.llm);
    if (llm === null) return;

    const callSites = readObject(llm.callSites);
    if (callSites === null) return;

    const mainAgent = readObject(callSites.mainAgent);
    if (mainAgent === null) return;
    if ("provider" in mainAgent || "profile" in mainAgent) return;
    if (mainAgent.model !== SEEDED_MAIN_AGENT_MODEL) return;
    if (mainAgent.maxTokens !== SEEDED_MAIN_AGENT_MAX_TOKENS) return;

    if (llm.activeProfile === undefined) {
      llm.activeProfile = DEFAULT_MANAGED_PROFILE;
    }

    delete mainAgent.model;
    delete mainAgent.maxTokens;

    if (Object.keys(mainAgent).length === 0) {
      delete callSites.mainAgent;
    } else {
      callSites.mainAgent = mainAgent;
    }

    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },
  down(_workspaceDir: string): void {
    // Forward-only: restoring the static call-site override would mask
    // the user's active inference profile for main assistant conversations.
  },
};

function readObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

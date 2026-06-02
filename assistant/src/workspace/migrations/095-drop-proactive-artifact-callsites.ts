import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

const REMOVED_CALL_SITES = [
  "proactiveArtifactDecision",
  "proactiveArtifactBuild",
] as const;

export const dropProactiveArtifactCallsitesMigration: WorkspaceMigration = {
  id: "095-drop-proactive-artifact-callsites",
  description:
    "Strip proactive artifact LLM call-site overrides from config.json (feature removed)",
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

    const llm = readObject(config.llm);
    if (llm === null) return;

    const callSites = readObject(llm.callSites);
    if (callSites === null) return;

    let mutated = false;
    for (const callSite of REMOVED_CALL_SITES) {
      if (callSite in callSites) {
        delete callSites[callSite];
        mutated = true;
      }
    }

    if (mutated) {
      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    }
  },
  down(_workspaceDir: string): void {
    // Forward-only: these call-site IDs no longer exist in the schema or
    // runtime, so restoring their overrides would make config loading fail.
  },
};

function readObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

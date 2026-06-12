import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

/**
 * Add `disableCache: true` to existing on-disk entries for the one-shot LLM
 * call sites whose shipped defaults now opt out of prompt caching.
 *
 * The resolver prefers an explicit `llm.callSites.<id>` entry over
 * CALL_SITE_DEFAULTS, and earlier migrations (054 recall, 072 replySuggestion,
 * and platform overlays for the others) seeded such entries. Without this
 * migration, upgraded workspaces would keep paying prompt-cache writes on
 * call sites whose prompts never produce a cache read — only fresh installs
 * would pick up the new shipped default.
 *
 * Idempotent and customization-preserving: an entry that already carries a
 * `disableCache` key (either value — the user may have opted back in) is
 * left untouched, and only the one key is added to entries we patch. Entries
 * that don't exist on disk are skipped — those workspaces already resolve
 * the shipped default.
 */
const ONE_SHOT_CALL_SITES = [
  "recall",
  "replySuggestion",
  "homeGreeting",
  "homeSuggestedPrompts",
  "conversationTitle",
  "memoryConsolidation",
] as const;

export const disableCacheOneShotCallsitesMigration: WorkspaceMigration = {
  id: "099-disable-cache-one-shot-callsites",
  description:
    "Add disableCache: true to existing one-shot call-site entries so upgraded workspaces match the new shipped defaults",
  run(workspaceDir: string): void {
    if (process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH) return;

    const configPath = join(workspaceDir, "config.json");
    if (!existsSync(configPath)) return;

    let config: Record<string, unknown> = {};
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

    let changed = false;
    for (const callSite of ONE_SHOT_CALL_SITES) {
      const entry = readObject(callSites[callSite]);
      if (entry === null) continue;
      if ("disableCache" in entry) continue;
      entry.disableCache = true;
      callSites[callSite] = entry;
      changed = true;
    }
    if (!changed) return;

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

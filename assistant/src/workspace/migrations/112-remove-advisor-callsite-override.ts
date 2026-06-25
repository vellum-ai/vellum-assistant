import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

/**
 * Strip a persisted `llm.callSites.advisor` entry from existing config files.
 *
 * `advisor` is not a valid `LLMCallSiteEnum` key, so a saved
 * `llm.callSites.advisor.profile` is rejected on parse by the
 * `z.partialRecord(LLMCallSiteEnum, ...)` schema. The loader recovers (logs
 * `Invalid config at "llm.callSites.advisor"...`, deletes the key, re-parses),
 * so it is not a crash — but the warning is logged on every boot, and because
 * `GET /config` serves the raw file the web "Overrides" badge keeps counting
 * the invalid key with no reset path.
 *
 * This migration strips the key once. The now-empty `llm.callSites` object is
 * pruned if `advisor` was its only key (the schema defaults `callSites` to
 * `{}`, so an absent key is equivalent to an empty map). Other call-site keys
 * and the unrelated top-level `llm.advisorProfile` selection are left intact.
 *
 * No-op for configs that never had the key. Idempotent.
 */
export const removeAdvisorCallsiteOverrideMigration: WorkspaceMigration = {
  id: "112-remove-advisor-callsite-override",
  description:
    "Remove the stale advisor entry from llm.callSites (advisor call site removed)",
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
    if (!("advisor" in sites)) return;

    delete sites.advisor;

    // Prune the now-empty callSites map; an absent key is equivalent to the
    // schema's `{}` default.
    if (Object.keys(sites).length === 0) {
      delete (llm as Record<string, unknown>).callSites;
    }

    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },
  down(_workspaceDir: string): void {
    // Forward-only — the advisor call site no longer exists.
  },
};

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

/**
 * Seed `callSites.mainAgent = { model: "claude-opus-4-7" }` so the main
 * agent conversation loop stays on Opus even though the schema-level
 * default dropped to Sonnet. Runs in two modes, mirroring migration 040:
 *
 *   1. **Existing workspace** (config.json present): merge the seed into
 *      `llm.callSites` without overwriting a user-defined override.
 *   2. **Fresh install** (config.json absent): write a minimal starter
 *      config with just this seed. `loadConfig()` runs after migrations
 *      and backfills the remaining schema defaults via `deepMergeMissing`.
 *
 * Applied only when:
 *   - the resolved provider is Anthropic (other providers own their
 *     own mainAgent model choice), **and**
 *   - `llm.default.model` is either unset or equal to the previous
 *     schema default `claude-opus-4-7` — a user who explicitly picked
 *     a different Anthropic model (e.g. Haiku) kept their own choice,
 *     so forcing Opus onto their mainAgent would be surprising.
 */
export const seedMainAgentOpusCallsiteMigration: WorkspaceMigration = {
  id: "048-seed-main-agent-opus-callsite",
  description: "Seed callSites.mainAgent to claude-opus-4-7 for Anthropic",
  run(workspaceDir: string): void {
    // Defer to platform-provided overlays.
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
    const defaultBlock = readObject(llm.default);

    const explicitProvider = readString(defaultBlock?.provider);
    if (explicitProvider !== undefined && explicitProvider !== "anthropic") {
      return;
    }

    const explicitModel = readString(defaultBlock?.model);
    if (explicitModel !== undefined && explicitModel !== "claude-opus-4-7") {
      return;
    }

    const callSites = readObject(llm.callSites) ?? {};

    if (readObject(callSites.mainAgent) !== null) return;

    callSites.mainAgent = { model: "claude-opus-4-7" };
    llm.callSites = callSites;
    config.llm = llm;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },
  down(_workspaceDir: string): void {
    // Forward-only: removing the seed would silently downgrade the main
    // agent loop to Sonnet on every re-run.
  },
};

function readObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

/**
 * Repair stale OpenRouter xAI model IDs in workspace LLM config.
 *
 * OpenRouter no longer serves `x-ai/grok-4.20-beta` (graduated to
 * `x-ai/grok-4.20`) or `x-ai/grok-4` (retired; `x-ai/grok-4.5` is the current
 * flagship), and both IDs are gone from the provider catalog, so requests
 * pinning them fail with a model-not-found error. Repair known LLM config
 * leaves where clients write model IDs — `llm.default`, `llm.callSites.*`,
 * and `llm.profiles.*` — only on an exact stale match, and only when the
 * fragment's provider is OpenRouter.
 *
 * Provider guard: both stale IDs were catalog entries owned solely by the
 * `openrouter` provider, so the resolver's catalog-implied-provider stamping
 * resolved every provider-less fragment carrying them to OpenRouter. A
 * fragment is therefore repaired when its `provider` is `"openrouter"` or
 * absent; an explicit non-OpenRouter provider (e.g. an `openai-compatible`
 * endpoint serving a model by the same name) is left untouched.
 */
export const repairStaleOpenrouterGrokModelIdsMigration: WorkspaceMigration = {
  id: "128-repair-stale-openrouter-grok-model-ids",
  description:
    "Repair stale OpenRouter x-ai/grok-4.20-beta and x-ai/grok-4 model IDs in workspace LLM config",
  run(workspaceDir: string): void {
    const configPath = join(workspaceDir, "config.json");
    if (!existsSync(configPath)) {
      return;
    }

    let config: Record<string, unknown>;
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return;
      }
      config = raw as Record<string, unknown>;
    } catch {
      return;
    }

    const llm = readObject(config.llm);
    if (llm === null) {
      return;
    }

    let changed = false;

    changed = repairFragment(readObject(llm.default)) || changed;

    const callSites = readObject(llm.callSites);
    if (callSites !== null) {
      for (const rawConfig of Object.values(callSites)) {
        changed = repairFragment(readObject(rawConfig)) || changed;
      }
    }

    const profiles = readObject(llm.profiles);
    if (profiles !== null) {
      for (const rawProfile of Object.values(profiles)) {
        changed = repairFragment(readObject(rawProfile)) || changed;
      }
    }

    if (!changed) {
      return;
    }

    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },
  down(_workspaceDir: string): void {
    // Forward-only: reintroducing the stale model IDs would break OpenRouter
    // calls.
  },
};

// ---------------------------------------------------------------------------
// Helpers — self-contained per workspace migrations AGENTS.md
// ---------------------------------------------------------------------------

const REPLACEMENTS: Record<string, string> = {
  "x-ai/grok-4.20-beta": "x-ai/grok-4.20",
  "x-ai/grok-4": "x-ai/grok-4.5",
};

function repairFragment(fragment: Record<string, unknown> | null): boolean {
  if (fragment === null) {
    return false;
  }
  if (typeof fragment.model !== "string") {
    return false;
  }
  const replacement = REPLACEMENTS[fragment.model];
  if (replacement === undefined) {
    return false;
  }
  if (fragment.provider !== undefined && fragment.provider !== "openrouter") {
    return false;
  }
  fragment.model = replacement;
  return true;
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

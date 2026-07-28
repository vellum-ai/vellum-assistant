import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

/**
 * Repair the stale Fireworks Kimi K2.5 model ID in workspace LLM config.
 *
 * Fireworks withdrew the serverless deployment of
 * `accounts/fireworks/models/kimi-k2p5` (the model page now lists it as
 * on-demand/dedicated only), so serverless chat/completions calls fail with
 * a 404 "Model not found, inaccessible, and/or not deployed". The ID was
 * seeded widely: it was the Fireworks `latency-optimized` intent and the
 * Fireworks provider default, and older migrations (038/040/054/066/073)
 * stamped it into call sites, so affected assistants throw
 * model-not-found on every message routed through those entries
 * (ATL-1164, ATL-1167, ATL-1144, ATL-1142).
 *
 * Repair known LLM config leaves where clients write model IDs
 * (`llm.default`, `llm.callSites.*`, and `llm.profiles.*`) only on an
 * exact stale match, replacing with `accounts/fireworks/models/
 * deepseek-v4-flash` (the same latency-intent replacement the managed
 * catalog already made, verified serverless-servable).
 *
 * Provider guard: the stale ID was a catalog entry owned by the
 * `fireworks` provider and also appears in managed profiles stamped
 * `provider: "vellum"` (which route Fireworks-account model IDs through
 * the managed proxy). A fragment is repaired when its `provider` is
 * `"fireworks"`, `"vellum"`, or absent; an explicit other provider (e.g.
 * an `openai-compatible` endpoint serving a model by the same name) is
 * left untouched.
 */
export const repairStaleFireworksKimiModelIdMigration: WorkspaceMigration = {
  id: "136-repair-stale-fireworks-kimi-model-id",
  description:
    "Repair stale Fireworks accounts/fireworks/models/kimi-k2p5 model ID in workspace LLM config",
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
    // Forward-only: reintroducing the stale model ID would break Fireworks
    // calls.
  },
};

// ---------------------------------------------------------------------------
// Helpers: self-contained per workspace migrations AGENTS.md
// ---------------------------------------------------------------------------

const STALE_MODEL_ID = "accounts/fireworks/models/kimi-k2p5";
const REPLACEMENT_MODEL_ID = "accounts/fireworks/models/deepseek-v4-flash";
const REPAIRABLE_PROVIDERS = new Set(["fireworks", "vellum"]);

function repairFragment(fragment: Record<string, unknown> | null): boolean {
  if (fragment === null) {
    return false;
  }
  if (fragment.model !== STALE_MODEL_ID) {
    return false;
  }
  if (
    fragment.provider !== undefined &&
    !REPAIRABLE_PROVIDERS.has(fragment.provider as string)
  ) {
    return false;
  }
  fragment.model = REPLACEMENT_MODEL_ID;
  return true;
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

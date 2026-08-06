import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

/**
 * Repair the stale Fireworks Kimi K2.5 model ID in workspace LLM config.
 *
 * `accounts/fireworks/models/kimi-k2p5` has no serverless deployment on
 * Fireworks (on-demand/dedicated only), so serverless chat/completions
 * calls fail with a 404 "Model not found, inaccessible, and/or not
 * deployed". Existing configs can still pin the ID in `llm.default`,
 * `llm.callSites.*`, and `llm.profiles.*`.
 *
 * Repair those leaves only on an exact stale match, replacing with
 * `accounts/fireworks/models/deepseek-v4-flash`, the catalog's current
 * Fireworks latency-intent model.
 *
 * Provider guard: the stale ID belongs to the `fireworks` provider and
 * also appears in managed profiles stamped
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

    // Read outside the parse catch: a transient filesystem error (EIO,
    // EACCES) must reach the runner so the migration retries, while
    // malformed JSON is a permanent state this migration cannot repair.
    const rawText = readFileSync(configPath, "utf-8");

    let config: Record<string, unknown>;
    try {
      const raw = JSON.parse(rawText);
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

    // Write-then-rename so an interrupted write cannot leave config.json
    // truncated: a torn in-place write would parse as invalid JSON on the
    // retry, which the catch above treats as "nothing to do", letting the
    // runner checkpoint the migration as completed against a corrupt file.
    const tmpPath = `${configPath}.migration-136.tmp`;
    writeFileSync(tmpPath, JSON.stringify(config, null, 2) + "\n");
    renameSync(tmpPath, configPath);
  },
  // The exact-match rewrite is idempotent, so a transient failure (full
  // disk, I/O error) is safe to retry on later startups.
  retryFailedCheckpoint: true,
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

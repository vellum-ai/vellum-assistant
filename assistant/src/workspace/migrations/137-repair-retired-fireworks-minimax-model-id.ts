import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

/**
 * Repair the retired Fireworks MiniMax M2.5 model ID in workspace LLM config.
 *
 * Fireworks no longer serves `accounts/fireworks/models/minimax-m2p5`, so
 * chat/completions calls fail with a 404 "Model not found, inaccessible,
 * and/or not deployed". The ID was never an intent default — it was only
 * reachable by picking it — but a config that picked it still pins it in
 * `llm.default`, `llm.callSites.*`, and `llm.profiles.*`.
 *
 * Repair those leaves only on an exact match, replacing with
 * `accounts/fireworks/models/minimax-m2p7`: the nearest live MiniMax entry
 * (same 196K window, same 25K output cap, same per-token pricing), so the
 * repaired pin keeps the model family the user chose. Deliberately not
 * `minimax-m3`, which is the current Fireworks balanced-intent model —
 * rewriting a hand-edited `custom-*` profile onto the template's model
 * would make it read as unedited to `ensureByokDefaultProfiles`.
 *
 * Provider guard: the retired ID belongs to the `fireworks` provider and
 * also appears in managed profiles stamped `provider: "vellum"` (which
 * route Fireworks-account model IDs through the managed proxy). A fragment
 * is repaired when its `provider` is `"fireworks"`, `"vellum"`, or absent;
 * an explicit other provider (e.g. an `openai-compatible` endpoint serving
 * a model by the same name) is left untouched.
 */
export const repairRetiredFireworksMinimaxModelIdMigration: WorkspaceMigration =
  {
    id: "137-repair-retired-fireworks-minimax-model-id",
    description:
      "Repair retired Fireworks accounts/fireworks/models/minimax-m2p5 model ID in workspace LLM config",
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
      const tmpPath = `${configPath}.migration-137.tmp`;
      writeFileSync(tmpPath, JSON.stringify(config, null, 2) + "\n");
      renameSync(tmpPath, configPath);
    },
    // The exact-match rewrite is idempotent, so a transient failure (full
    // disk, I/O error) is safe to retry on later startups.
    retryFailedCheckpoint: true,
    down(_workspaceDir: string): void {
      // Forward-only: reintroducing the retired model ID would break
      // Fireworks calls.
    },
  };

// ---------------------------------------------------------------------------
// Helpers: self-contained per workspace migrations AGENTS.md
// ---------------------------------------------------------------------------

const RETIRED_MODEL_ID = "accounts/fireworks/models/minimax-m2p5";
const REPLACEMENT_MODEL_ID = "accounts/fireworks/models/minimax-m2p7";
const REPAIRABLE_PROVIDERS = new Set(["fireworks", "vellum"]);

function repairFragment(fragment: Record<string, unknown> | null): boolean {
  if (fragment === null) {
    return false;
  }
  if (fragment.model !== RETIRED_MODEL_ID) {
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

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

/**
 * Repair the retired undated Fireworks DeepSeek V4 Flash model ID in
 * workspace LLM config.
 *
 * Fireworks removed the undated `accounts/fireworks/models/deepseek-v4-flash`
 * deployment (404 "Model not found, inaccessible, and/or not deployed") and
 * now serves only the dated official release
 * `accounts/fireworks/models/deepseek-v4-flash-0731`. Existing configs can
 * still pin the undated ID in `llm.default`, `llm.callSites.*`, and
 * `llm.profiles.*` — the cost-optimized default profile carried it and
 * migration 136 rewrote stale kimi-k2p5 pins to it.
 *
 * Repair those leaves only on an exact stale match, replacing with the
 * dated ID.
 *
 * Provider guard: the stale ID belongs to the `fireworks` provider and also
 * appears in managed profiles stamped `provider: "vellum"` (which route
 * Fireworks-account model IDs through the managed proxy). A fragment is
 * repaired when its `provider` is `"fireworks"`, `"vellum"`, or absent; an
 * explicit other provider — including a connection entry name written by
 * migration 145 — is left untouched: an `openai-compatible` endpoint may
 * legitimately serve a model by the stale name, and an entry-bound profile
 * is the user's to manage.
 */
export const repairRetiredFireworksDeepseekFlashModelIdMigration: WorkspaceMigration =
  {
    id: "146-repair-retired-fireworks-deepseek-flash-model-id",
    description:
      "Repair retired Fireworks accounts/fireworks/models/deepseek-v4-flash model ID in workspace LLM config",
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
      const tmpPath = `${configPath}.migration-146.tmp`;
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

const STALE_MODEL_ID = "accounts/fireworks/models/deepseek-v4-flash";
const REPLACEMENT_MODEL_ID = "accounts/fireworks/models/deepseek-v4-flash-0731";
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

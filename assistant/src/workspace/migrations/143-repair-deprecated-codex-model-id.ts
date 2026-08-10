import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

/**
 * Repair the deprecated `gpt-5.3-codex` model ID on ChatGPT-subscription
 * config fragments.
 *
 * OpenAI deprecated `gpt-5.3-codex` under ChatGPT sign-in (the Codex
 * endpoint rejects it with HTTP 400), so it is being removed from
 * `CODEX_SUBSCRIPTION_MODEL_IDS`. A workspace can still pin it on
 * `provider: "chatgpt"` fragments (migration 133 wrote exactly that shape
 * for `chatgpt-subscription` entries), and once the ID leaves the allowlist,
 * `LLMSchema.superRefine` rejects such a fragment. The loader's leaf
 * recovery then deletes the fragment's `model`, which still fails ("chatgpt"
 * requires an explicit model), and per-section salvage resets the whole
 * `llm` section, discarding the user's other LLM settings.
 *
 * Repair rewrites the model to `gpt-5.6-terra` (OpenAI's recommended
 * everyday Codex model) on an exact `provider: "chatgpt"` + model match in
 * `llm.default`, `llm.callSites.*`, and `llm.profiles.*`. A call-site
 * fragment is also repaired when it pins the model with no provider of its
 * own: at resolve time such a fragment overlays the winning profile, so the
 * stale pin rides whatever provider and connection the winner supplies
 * (including the subscription connection, which routes it to the Codex
 * endpoint). Fragments with any other explicit provider are left untouched:
 * the allowlist only gates the "chatgpt" routing identity, and a provider
 * like `openai-compatible` may legitimately serve this id.
 */
export const repairDeprecatedCodexModelIdMigration: WorkspaceMigration = {
  id: "143-repair-deprecated-codex-model-id",
  description:
    'Repair deprecated gpt-5.3-codex model ID on provider "chatgpt" fragments in workspace LLM config',
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
        changed =
          repairFragment(readObject(rawConfig), {
            repairMissingProvider: true,
          }) || changed;
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
    const tmpPath = `${configPath}.migration-143.tmp`;
    writeFileSync(tmpPath, JSON.stringify(config, null, 2) + "\n");
    renameSync(tmpPath, configPath);
  },
  // The exact-match rewrite is idempotent, so a transient failure (full
  // disk, I/O error) is safe to retry on later startups.
  retryFailedCheckpoint: true,
  down(_workspaceDir: string): void {
    // Forward-only: reintroducing the deprecated model ID would fail schema
    // validation once the allowlist no longer carries it.
  },
};

// ---------------------------------------------------------------------------
// Helpers: self-contained per workspace migrations AGENTS.md
// ---------------------------------------------------------------------------

const DEPRECATED_MODEL_ID = "gpt-5.3-codex";
const REPLACEMENT_MODEL_ID = "gpt-5.6-terra";

function repairFragment(
  fragment: Record<string, unknown> | null,
  options?: { repairMissingProvider?: boolean },
): boolean {
  if (fragment === null || fragment.model !== DEPRECATED_MODEL_ID) {
    return false;
  }
  const providerRepairable =
    fragment.provider === "chatgpt" ||
    (options?.repairMissingProvider === true &&
      fragment.provider === undefined);
  if (!providerRepairable) {
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

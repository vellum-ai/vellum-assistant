import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import type { WorkspaceMigration } from "./types.js";

/**
 * Repair the retired Fireworks model IDs in workspace LLM config.
 *
 * Fireworks has no serverless deployment of DeepSeek V4 Flash 0731,
 * DeepSeek V4 Pro 0813 or Kimi K2.6: chat/completions calls fail with a
 * 404 "Model not found, inaccessible, and/or not deployed". Existing
 * configs can pin any of these IDs in `llm.default`, `llm.callSites.*`, and `llm.profiles.*`.
 *
 * Repair those leaves only on an exact stale match, replacing with the
 * successor Fireworks names (see `REPLACEMENT_BY_STALE_MODEL_ID`). Kimi
 * K2.6 has two named successors; Kimi K3 is the one that accepts image
 * input, which Kimi K2.6 does.
 *
 * A replacement can also be an intent template's model, so a repaired
 * hand-edited `custom-*` profile can read as unedited to
 * `ensureByokDefaultProfiles` and collapse into that default. That is
 * acceptable: the collapsed copy routes to the same model this migration
 * writes.
 *
 * Provider guard: the stale IDs belong to the `fireworks` provider and also
 * appear in managed profiles stamped `provider: "vellum"` (which route
 * Fireworks-account model IDs through the managed proxy). Under the entries
 * model (migration 145) `provider` can also hold a `provider_connections`
 * entry name whose row kind drives dispatch. A fragment is repaired when
 * its `provider` is `"fireworks"`, `"vellum"`, absent, or an entry name
 * whose row kind is one of those. Any other provider is left untouched: an
 * `openai-compatible` endpoint may legitimately serve a model by the stale
 * name.
 */
export const repairRetiredFireworksModelIdsMigration: WorkspaceMigration = {
  id: "160-repair-retired-fireworks-model-ids",
  description: "Repair retired Fireworks model IDs in workspace LLM config",
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

    // Entry rows load lazily: only a stale fragment whose provider is
    // neither a repairable vendor nor absent needs them. An unreadable DB
    // then fails the run (retried next boot) rather than checkpointing a
    // pass that skips entry-bound profiles.
    let rows: Map<string, string> | null | undefined;
    const isRepairableProvider = (provider: unknown): boolean => {
      if (provider === undefined) {
        return true;
      }
      if (typeof provider !== "string") {
        return false;
      }
      if (REPAIRABLE_PROVIDERS.has(provider)) {
        return true;
      }
      if (rows === undefined) {
        rows = readConnectionRows(workspaceDir);
      }
      if (rows === null) {
        throw new Error(
          "provider_connections is not readable; retrying the model-ID repair on the next run",
        );
      }
      const kind = rows.get(provider);
      return kind !== undefined && REPAIRABLE_PROVIDERS.has(kind);
    };

    let changed = false;

    changed =
      repairFragment(readObject(llm.default), isRepairableProvider) || changed;

    const callSites = readObject(llm.callSites);
    if (callSites !== null) {
      for (const rawConfig of Object.values(callSites)) {
        changed =
          repairFragment(readObject(rawConfig), isRepairableProvider) ||
          changed;
      }
    }

    const profiles = readObject(llm.profiles);
    if (profiles !== null) {
      for (const rawProfile of Object.values(profiles)) {
        changed =
          repairFragment(readObject(rawProfile), isRepairableProvider) ||
          changed;
      }
    }

    if (!changed) {
      return;
    }

    // Write-then-rename so an interrupted write cannot leave config.json
    // truncated: a torn in-place write would parse as invalid JSON on the
    // retry, which the catch above treats as "nothing to do", letting the
    // runner checkpoint the migration as completed against a corrupt file.
    const tmpPath = `${configPath}.migration-160.tmp`;
    writeFileSync(tmpPath, JSON.stringify(config, null, 2) + "\n");
    renameSync(tmpPath, configPath);
  },
  // The exact-match rewrite is idempotent, so a transient failure (full
  // disk, I/O error) is safe to retry on later startups.
  retryFailedCheckpoint: true,
  down(_workspaceDir: string): void {
    // Forward-only: reintroducing a retired model ID would break
    // Fireworks calls.
  },
};

// ---------------------------------------------------------------------------
// Helpers: self-contained per workspace migrations AGENTS.md
// ---------------------------------------------------------------------------

const REPLACEMENT_BY_STALE_MODEL_ID = new Map([
  [
    "accounts/fireworks/models/deepseek-v4-flash-0731",
    "accounts/fireworks/models/deepseek-v4p1-flash",
  ],
  [
    "accounts/fireworks/models/deepseek-v4-pro-0813",
    "accounts/fireworks/models/deepseek-v4p1-flash",
  ],
  ["accounts/fireworks/models/kimi-k2p6", "accounts/fireworks/models/kimi-k3"],
]);
const REPAIRABLE_PROVIDERS = new Set(["fireworks", "vellum"]);

function repairFragment(
  fragment: Record<string, unknown> | null,
  isRepairableProvider: (provider: unknown) => boolean,
): boolean {
  if (fragment === null) {
    return false;
  }
  if (typeof fragment.model !== "string") {
    return false;
  }
  const replacement = REPLACEMENT_BY_STALE_MODEL_ID.get(fragment.model);
  if (replacement === undefined) {
    return false;
  }
  if (!isRepairableProvider(fragment.provider)) {
    return false;
  }
  fragment.model = replacement;
  return true;
}

/**
 * Connection name -> provider kind, or null when the DB or table is not
 * readable. The caller fails the run on null: entry-name providers must be
 * judged against real rows, never guessed. An absent DB file is a real
 * state (no rows, so every entry name is dangling and stays untouched).
 */
function readConnectionRows(workspaceDir: string): Map<string, string> | null {
  const dbPath = join(workspaceDir, "data", "db", "assistant.db");
  if (!existsSync(dbPath)) {
    return new Map();
  }
  let db: Database;
  try {
    db = new Database(dbPath);
  } catch {
    return null;
  }
  try {
    const rows = db
      .query(`SELECT name, provider FROM provider_connections`)
      .all() as Array<{ name: string; provider: string }>;
    return new Map(rows.map((r) => [r.name, r.provider]));
  } catch {
    return null;
  } finally {
    db.close();
  }
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

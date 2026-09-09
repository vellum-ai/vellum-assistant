import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import type { WorkspaceMigration } from "./types.js";

/**
 * Repair `gpt-5.4` and `gpt-5.4-mini` pins that route through the ChatGPT
 * subscription.
 *
 * OpenAI serves neither model under ChatGPT sign-in: the Codex endpoint
 * rejects them with HTTP 400 ("not supported when using Codex with a
 * ChatGPT account"), so both are out of `CODEX_SUBSCRIPTION_MODEL_IDS`.
 * API-key access is unaffected, so the repair is scoped to fragments that
 * provably dispatch to the subscription; an `openai` (or any other vendor)
 * fragment keeps its model.
 *
 * A fragment routes through the subscription when its `provider` is the
 * `chatgpt` routing identity, or an entry name whose `provider_connections`
 * row is the subscription (row kind `chatgpt`, or an `oauth_subscription`
 * auth on the pre-DB-migration-366 row shape). The identity form fails
 * `LLMSchema.superRefine` once the allowlist drops the model, and the
 * loader's per-section salvage then resets the whole `llm` section; the
 * entry-bound form bypasses the auto-resolution compat gate and 400s on
 * every request. Both are swept in `llm.default`, `llm.callSites.*`, and
 * `llm.profiles.*`.
 *
 * Providerless fragments are left untouched: a call-site pin rides the
 * winning profile's provider, which may be an API-key or managed route that
 * still serves the model. Replacements: `gpt-5.4` becomes `gpt-5.5` (its
 * successor) and `gpt-5.4-mini` becomes `gpt-5.6-luna` (the subscription's
 * Balanced model; on the subscription every model bills the same).
 */
export const repairRetiredCodexGpt54ModelIdsMigration: WorkspaceMigration = {
  id: "153-repair-retired-codex-gpt-5-4-model-ids",
  description:
    "Repair gpt-5.4 and gpt-5.4-mini pins on ChatGPT-subscription LLM fragments in workspace config",
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
    // neither the identity nor absent needs them. An unreadable DB then
    // fails the run (retried next boot) rather than checkpointing a pass
    // that skips entry-bound profiles.
    let subscriptionEntries: Set<string> | null | undefined;
    const isSubscriptionProvider = (provider: unknown): boolean => {
      if (provider === CHATGPT_IDENTITY) {
        return true;
      }
      if (typeof provider !== "string" || provider.length === 0) {
        return false;
      }
      if (subscriptionEntries === undefined) {
        subscriptionEntries = readSubscriptionEntryNames(workspaceDir);
      }
      if (subscriptionEntries === null) {
        throw new Error(
          "provider_connections is not readable; retrying the model-ID repair on the next run",
        );
      }
      return subscriptionEntries.has(provider);
    };

    let changed = false;

    changed =
      repairFragment(readObject(llm.default), isSubscriptionProvider) ||
      changed;

    const callSites = readObject(llm.callSites);
    if (callSites !== null) {
      for (const rawConfig of Object.values(callSites)) {
        changed =
          repairFragment(readObject(rawConfig), isSubscriptionProvider) ||
          changed;
      }
    }

    const profiles = readObject(llm.profiles);
    if (profiles !== null) {
      for (const rawProfile of Object.values(profiles)) {
        changed =
          repairFragment(readObject(rawProfile), isSubscriptionProvider) ||
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
    const tmpPath = `${configPath}.migration-153.tmp`;
    writeFileSync(tmpPath, JSON.stringify(config, null, 2) + "\n");
    renameSync(tmpPath, configPath);
  },
  // The exact-match rewrite is idempotent, so a transient failure (full
  // disk, I/O error) is safe to retry on later startups.
  retryFailedCheckpoint: true,
  down(_workspaceDir: string): void {
    // Forward-only: reintroducing the retired model IDs would fail schema
    // validation once the allowlist no longer carries them.
  },
};

// ---------------------------------------------------------------------------
// Helpers: self-contained per workspace migrations AGENTS.md
// ---------------------------------------------------------------------------

const CHATGPT_IDENTITY = "chatgpt";

const REPLACEMENTS: ReadonlyMap<string, string> = new Map([
  ["gpt-5.4", "gpt-5.5"],
  ["gpt-5.4-mini", "gpt-5.6-luna"],
]);

function repairFragment(
  fragment: Record<string, unknown> | null,
  isSubscriptionProvider: (provider: unknown) => boolean,
): boolean {
  if (fragment === null || typeof fragment.model !== "string") {
    return false;
  }
  const replacement = REPLACEMENTS.get(fragment.model);
  if (replacement === undefined) {
    return false;
  }
  if (!isSubscriptionProvider(fragment.provider)) {
    return false;
  }
  fragment.model = replacement;
  return true;
}

/**
 * Names of `provider_connections` rows that dispatch to the ChatGPT
 * subscription, or null when the DB or table is not readable. The caller
 * fails the run on null: entry-name providers must be judged against real
 * rows, never guessed. An absent DB file is a real state (no rows, so every
 * entry name is dangling and stays untouched).
 */
function readSubscriptionEntryNames(workspaceDir: string): Set<string> | null {
  const dbPath = join(workspaceDir, "data", "db", "assistant.db");
  if (!existsSync(dbPath)) {
    return new Set();
  }
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    return null;
  }
  try {
    const rows = db
      .query(`SELECT name, provider, auth FROM provider_connections`)
      .all() as Array<{ name: string; provider: string; auth: string }>;
    const names = new Set<string>();
    for (const row of rows) {
      if (row.provider === CHATGPT_IDENTITY || isSubscriptionAuth(row.auth)) {
        names.add(row.name);
      }
    }
    return names;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

function isSubscriptionAuth(auth: string): boolean {
  try {
    const parsed: unknown = JSON.parse(auth);
    return (
      parsed !== null &&
      typeof parsed === "object" &&
      (parsed as { type?: unknown }).type === "oauth_subscription"
    );
  } catch {
    return false;
  }
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import type { WorkspaceMigration } from "./types.js";

/**
 * Repair `gpt-5.4` and `gpt-5.4-mini` pins on fragments that dispatch
 * through the ChatGPT subscription.
 *
 * OpenAI serves neither model under ChatGPT sign-in: the Codex endpoint
 * rejects them with HTTP 400 ("not supported when using Codex with a
 * ChatGPT account"), so both are out of `CODEX_SUBSCRIPTION_MODEL_IDS`.
 * API-key access is unaffected, so a fragment on any other route keeps
 * its model.
 *
 * Two stored shapes dispatch through the subscription. The `chatgpt`
 * routing identity fails `LLMSchema.superRefine` once the allowlist drops
 * the model, and the loader's per-section salvage then resets the whole
 * `llm` section, losing every profile and call-site tuning: this is the
 * repair that prevents data loss. A profile bound to the subscription row
 * (row kind `chatgpt`, or an `oauth_subscription` auth on the
 * pre-DB-migration-366 row shape) bypasses the auto-resolution compat
 * gate and 400s on every request; the row is named by the legacy
 * `provider_connection` binding when present (dispatch honors it first,
 * and the name is only ever a row name), otherwise by an entry-name
 * `provider`. Both shapes are swept in `llm.default`, `llm.callSites.*`,
 * and `llm.profiles.*`; call-site fragments carry no binding (the schema
 * strips a raw `provider_connection`), so only their declared provider
 * counts.
 *
 * A providerless call-site pin is deliberately left alone. It overlays
 * whichever profile wins the site for a turn: on an API-key or managed
 * winner it still serves the model, and on a subscription winner the
 * request already fails upstream and keeps failing, with no config loss
 * either way. Rewriting such pins would change API-key users' model and
 * price to cover a winner that may never be selected.
 *
 * Replacements: `gpt-5.4` becomes `gpt-5.5` (its successor) and
 * `gpt-5.4-mini` becomes `gpt-5.6-luna` (the subscription's Balanced model;
 * on the subscription every model bills the same).
 */
export const repairRetiredCodexGpt54ModelIdsMigration: WorkspaceMigration = {
  id: "154-repair-retired-codex-gpt-5-4-model-ids",
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

    // Entry rows load lazily: only a stale fragment naming a row needs
    // them. An unreadable DB then fails the run (retried next boot) rather
    // than checkpointing a pass that skips entry-bound profiles.
    let rows: Map<string, boolean> | null | undefined;
    const isSubscriptionRow = (name: unknown): boolean => {
      if (typeof name !== "string" || name.length === 0) {
        return false;
      }
      if (rows === undefined) {
        rows = readConnectionRows(workspaceDir);
      }
      if (rows === null) {
        throw new Error(
          "provider_connections is not readable; retrying the model-ID repair on the next run",
        );
      }
      return rows.get(name) === true;
    };
    // A `provider` value: the identity dispatches to the subscription, a
    // known vendor never does, and any other value is an entry name.
    const isSubscriptionProvider = (provider: unknown): boolean =>
      provider === CHATGPT_IDENTITY ||
      (typeof provider === "string" &&
        !KNOWN_PROVIDERS.has(provider) &&
        isSubscriptionRow(provider));
    // The binding is authoritative when present, since dispatch honors it
    // ahead of the declared provider; the identity is repaired regardless
    // (the schema rejects the pair whatever the binding).
    const isBound = (fragment: Record<string, unknown>): boolean => {
      if (fragment.provider === CHATGPT_IDENTITY) {
        return true;
      }
      const binding = fragment.provider_connection;
      return typeof binding === "string" && binding.length > 0
        ? isSubscriptionRow(binding)
        : isSubscriptionProvider(fragment.provider);
    };
    const isProviderBound = (fragment: Record<string, unknown>): boolean =>
      isSubscriptionProvider(fragment.provider);

    let changed = false;

    changed = repairFragment(readObject(llm.default), isBound) || changed;

    const callSites = readObject(llm.callSites);
    if (callSites !== null) {
      for (const rawConfig of Object.values(callSites)) {
        changed =
          repairFragment(readObject(rawConfig), isProviderBound) || changed;
      }
    }

    const profiles = readObject(llm.profiles);
    if (profiles !== null) {
      for (const rawProfile of Object.values(profiles)) {
        changed = repairFragment(readObject(rawProfile), isBound) || changed;
      }
    }

    if (!changed) {
      return;
    }

    // Write-then-rename so an interrupted write cannot leave config.json
    // truncated: a torn in-place write would parse as invalid JSON on the
    // retry, which the catch above treats as "nothing to do", letting the
    // runner checkpoint the migration as completed against a corrupt file.
    const tmpPath = `${configPath}.migration-154.tmp`;
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

// Frozen snapshot of `KNOWN_LLM_PROVIDERS`: the vendor and identity values
// that dispatch without a connection row, so none of them is an entry name.
const KNOWN_PROVIDERS = new Set([
  "anthropic",
  "openai",
  "gemini",
  "ollama",
  "fireworks",
  "openrouter",
  "vercel-ai-gateway",
  "openai-compatible",
  "minimax",
  "atlascloud",
  "together",
  "litellm",
  "opencode",
  "baseten",
  "poolside",
  "vellum",
  "chatgpt",
]);

const REPLACEMENTS: ReadonlyMap<string, string> = new Map([
  ["gpt-5.4", "gpt-5.5"],
  ["gpt-5.4-mini", "gpt-5.6-luna"],
]);

function repairFragment(
  fragment: Record<string, unknown> | null,
  isSubscriptionRouted: (fragment: Record<string, unknown>) => boolean,
): boolean {
  if (fragment === null || typeof fragment.model !== "string") {
    return false;
  }
  const replacement = REPLACEMENTS.get(fragment.model);
  if (replacement === undefined) {
    return false;
  }
  if (!isSubscriptionRouted(fragment)) {
    return false;
  }
  fragment.model = replacement;
  return true;
}

/**
 * `provider_connections` row name to whether the row dispatches to the
 * ChatGPT subscription, or null when the DB or table is not readable. The
 * caller fails the run on null: entry-name providers must be judged against
 * real rows, never guessed. An absent DB file is a real state (no rows, so
 * every entry name is dangling).
 */
function readConnectionRows(workspaceDir: string): Map<string, boolean> | null {
  const dbPath = join(workspaceDir, "data", "db", "assistant.db");
  if (!existsSync(dbPath)) {
    return new Map();
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
    return new Map(
      rows.map((row) => [
        row.name,
        row.provider === CHATGPT_IDENTITY || isSubscriptionAuth(row.auth),
      ]),
    );
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

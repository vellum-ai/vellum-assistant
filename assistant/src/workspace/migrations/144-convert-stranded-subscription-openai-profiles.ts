import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger("migration-144");

/**
 * Convert stranded subscription-only `provider: "openai"` fragments to the
 * `chatgpt` routing identity.
 *
 * The ChatGPT-subscription connection row carries `provider: "chatgpt"`
 * (DB migration 366 stamps existing rows). An UNPINNED profile or call-site
 * fragment with `provider: "openai"` resolves by listing active openai
 * connections at dispatch; in a workspace whose only OpenAI access is the
 * subscription, that listing is now empty and every request on the fragment
 * fails with missing_connection. Workspace migration 133 converted fragments
 * that PINNED the subscription row; this converts the unpinned cohort.
 *
 * Conversion requires proof from the workspace DB that the fragment is
 * genuinely stranded: the canonical subscription row exists (matched by
 * name + oauth_subscription auth, valid for both the pre- and post-366 row
 * shapes) and no `provider: "openai"` row exists (an API-key row means
 * openai fragments still resolve). When the DB or table is absent or
 * unreadable, nothing converts.
 *
 * A converted fragment gets `provider: "chatgpt"`, and a model outside the
 * Codex subscription set is replaced with `gpt-5.6-terra` (the "chatgpt"
 * identity requires a Codex-servable model at schema validation; on the
 * subscription every model bills the same). Fragments with a
 * `provider_connection` pin, any other provider, or a managed source are
 * left untouched. `llm.default` is not swept: migration 133 drops that
 * legacy blob and runs earlier in the chain.
 */
export const convertStrandedSubscriptionOpenaiProfilesMigration: WorkspaceMigration =
  {
    id: "144-convert-stranded-subscription-openai-profiles",
    description:
      'Convert unpinned provider "openai" LLM fragments to the "chatgpt" routing identity in subscription-only workspaces',
    run(workspaceDir: string): void {
      const configPath = join(workspaceDir, "config.json");
      if (!existsSync(configPath)) {
        return;
      }
      if (!isSubscriptionOnlyWorkspace(workspaceDir)) {
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

      const profiles = readObject(llm.profiles);
      if (profiles !== null) {
        for (const [name, rawProfile] of Object.entries(profiles)) {
          if (convertFragment(readObject(rawProfile))) {
            changed = true;
            log.info({ profile: name }, "Converted stranded openai profile");
          }
        }
      }

      const callSites = readObject(llm.callSites);
      if (callSites !== null) {
        for (const [id, rawConfig] of Object.entries(callSites)) {
          if (convertFragment(readObject(rawConfig))) {
            changed = true;
            log.info(
              { callSite: id },
              "Converted stranded openai call-site fragment",
            );
          }
        }
      }

      if (!changed) {
        return;
      }

      // Write-then-rename so an interrupted write cannot leave config.json
      // truncated: a torn in-place write would parse as invalid JSON on the
      // retry, which the catch above treats as "nothing to do", letting the
      // runner checkpoint the migration as completed against a corrupt file.
      const tmpPath = `${configPath}.migration-144.tmp`;
      writeFileSync(tmpPath, JSON.stringify(config, null, 2) + "\n");
      renameSync(tmpPath, configPath);
    },
    // The exact-match rewrite is idempotent, so a transient failure (full
    // disk, I/O error) is safe to retry on later startups.
    retryFailedCheckpoint: true,
    down(_workspaceDir: string): void {
      // Forward-only: converting back would restore fragments that cannot
      // resolve a connection.
    },
  };

// ---------------------------------------------------------------------------
// Helpers: self-contained per workspace migrations AGENTS.md
// ---------------------------------------------------------------------------

const SUBSCRIPTION_CONNECTION_NAME = "chatgpt-subscription";

const CODEX_SUBSCRIPTION_MODEL_IDS = new Set([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
]);

const FALLBACK_CODEX_MODEL = "gpt-5.6-terra";

/**
 * True only when the workspace DB proves the stranded condition: the
 * canonical subscription row is present and no openai row exists. Any
 * failure to read counts as unproven.
 */
function isSubscriptionOnlyWorkspace(workspaceDir: string): boolean {
  const dbPath = join(workspaceDir, "data", "db", "assistant.db");
  if (!existsSync(dbPath)) {
    return false;
  }

  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    return false;
  }

  try {
    const tableExists = db
      .query(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'provider_connections'`,
      )
      .get();
    if (!tableExists) {
      return false;
    }

    const subscription = db
      .query(`SELECT auth FROM provider_connections WHERE name = ?`)
      .get(SUBSCRIPTION_CONNECTION_NAME) as { auth: string } | null;
    if (!subscription) {
      return false;
    }
    try {
      const parsed: unknown = JSON.parse(subscription.auth);
      const authType =
        parsed !== null && typeof parsed === "object"
          ? (parsed as { type?: unknown }).type
          : undefined;
      if (authType !== "oauth_subscription") {
        return false;
      }
    } catch {
      return false;
    }

    // The canonical row itself stores provider "openai" until DB migration
    // 366 flips it, and this migration checkpoints once; counting the row
    // as an openai connection here would skip the conversion forever on
    // exactly the upgrade boot that needs it. Its subscription auth is
    // already verified above, so exclusion by name is safe.
    const openaiRow = db
      .query(
        `SELECT 1 FROM provider_connections WHERE provider = 'openai' AND name != ?`,
      )
      .get(SUBSCRIPTION_CONNECTION_NAME);
    return openaiRow === null;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

function convertFragment(fragment: Record<string, unknown> | null): boolean {
  if (fragment === null) {
    return false;
  }
  if (fragment.provider !== "openai" || "provider_connection" in fragment) {
    return false;
  }
  if (fragment.source === "managed") {
    return false;
  }
  fragment.provider = "chatgpt";
  if (
    typeof fragment.model !== "string" ||
    !CODEX_SUBSCRIPTION_MODEL_IDS.has(fragment.model)
  ) {
    fragment.model = FALLBACK_CODEX_MODEL;
  }
  return true;
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

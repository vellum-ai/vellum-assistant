import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import type { WorkspaceMigration } from "./types.js";

/**
 * Repoint legacy-shape LLM fragments (`provider: "openai-compatible"` plus a
 * `provider_connection` binding) whose bound row's endpoint host is
 * opencode.ai to `provider: "opencode"`.
 *
 * DB migration 383 restamps such rows as provider "opencode", and dispatch
 * requires a bound row's provider to equal the fragment's declared provider,
 * so a fragment left declaring "openai-compatible" would either mismatch or
 * auto-resolve to an unrelated generic row. Entry-shape fragments (provider
 * holds the row name) derive their kind from the row and need no rewrite.
 * Rows are judged by their base_url host, not their provider column, so the
 * result is the same whichever migration runs first.
 *
 * Swept in `llm.default` and `llm.profiles.*`; call-site fragments carry no
 * binding (the schema strips a raw `provider_connection`).
 */
export const repointOpencodeHostProviderFragmentsMigration: WorkspaceMigration =
  {
    id: "158-repoint-opencode-host-provider-fragments",
    description:
      "Repoint openai-compatible LLM fragments bound to opencode.ai connections to provider opencode",
    run(workspaceDir: string): void {
      const configPath = join(workspaceDir, "config.json");
      if (!existsSync(configPath)) {
        return;
      }

      // Read outside the parse catch: a transient filesystem error must reach
      // the runner so the migration retries, while malformed JSON is a
      // permanent state this migration cannot repair.
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

      // Rows load lazily: only a legacy-shape openai-compatible fragment
      // needs them. An unreadable DB then fails the run (retried next boot)
      // rather than checkpointing a pass that skipped bound fragments.
      let openCodeRows: Set<string> | null | undefined;
      const isOpenCodeRow = (name: unknown): boolean => {
        if (typeof name !== "string" || name.length === 0) {
          return false;
        }
        if (openCodeRows === undefined) {
          openCodeRows = readOpenCodeRowNames(workspaceDir);
        }
        if (openCodeRows === null) {
          throw new Error(
            "provider_connections is not readable; retrying the opencode repoint on the next run",
          );
        }
        return openCodeRows.has(name);
      };

      const repoint = (fragment: Record<string, unknown> | null): boolean => {
        if (
          fragment === null ||
          fragment.provider !== "openai-compatible" ||
          !isOpenCodeRow(fragment.provider_connection)
        ) {
          return false;
        }
        fragment.provider = "opencode";
        return true;
      };

      let changed = repoint(readObject(llm.default));
      const profiles = readObject(llm.profiles);
      if (profiles !== null) {
        for (const rawProfile of Object.values(profiles)) {
          changed = repoint(readObject(rawProfile)) || changed;
        }
      }
      if (!changed) {
        return;
      }

      // Write-then-rename so an interrupted write cannot leave config.json
      // truncated for the retry to misread as "nothing to do".
      const tmpPath = `${configPath}.migration-158.tmp`;
      writeFileSync(tmpPath, JSON.stringify(config, null, 2) + "\n");
      renameSync(tmpPath, configPath);
    },
    // The exact-match rewrite is idempotent, so a transient failure is safe
    // to retry on later startups.
    retryFailedCheckpoint: true,
    down(_workspaceDir: string): void {
      // Forward-only: the rows these fragments bind now carry provider
      // "opencode", so reverting the fragments would recreate the mismatch.
    },
  };

// ---------------------------------------------------------------------------
// Helpers: self-contained per workspace migrations AGENTS.md
// ---------------------------------------------------------------------------

/**
 * Names of `provider_connections` rows whose base_url host is opencode.ai or
 * a subdomain, or null when the DB or table is not readable. An absent DB
 * file is a real state (no rows, so no fragment is bound to one).
 */
function readOpenCodeRowNames(workspaceDir: string): Set<string> | null {
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
      .query(
        `SELECT name, base_url FROM provider_connections WHERE base_url IS NOT NULL`,
      )
      .all() as Array<{ name: string; base_url: string }>;
    return new Set(
      rows.filter((row) => isOpenCodeHost(row.base_url)).map((row) => row.name),
    );
  } catch {
    return null;
  } finally {
    db.close();
  }
}

function isOpenCodeHost(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === "opencode.ai" || host.endsWith(".opencode.ai");
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

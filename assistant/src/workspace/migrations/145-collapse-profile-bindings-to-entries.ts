import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger("migrations/145-collapse-profile-bindings-to-entries");

// Fold each profile's `provider_connection` into its `provider` as a
// connection entry name. Under the entries model the provider field holds
// the entry name and the row's own provider (its kind) drives dispatch, so
// an explicit binding needs no second field.
//
// Rules per `llm.profiles.<key>`:
// - Routing-identity providers ("vellum"/"chatgpt") carry no binding by
//   definition: a stray `provider_connection` is deleted verbatim.
// - A binding whose row EXISTS and whose kind AGREES with the profile's
//   declared provider becomes the provider value (the entry name), and the
//   binding field is deleted. Kind agreement, with the identity kinds
//   mapped the way dispatch maps them: a row of the same provider, a
//   "chatgpt" row for a declared "openai", or a "vellum" row for a declared
//   managed-routable provider.
// - A dangling binding (row deleted) or a kind-disagreeing binding keeps
//   the declared provider and deletes only the binding, with a structured
//   warn: dispatch's auto-resolution then behaves the way it always has
//   for an unbound vendor profile, and a rewrite would either strand the
//   profile on a nonexistent entry or silently change vendors.
// - A binding equal to the declared provider (conventional shapes older
//   migrations kept) is a plain delete: the bare vendor value already
//   means the default entry of that kind.
//
// Call-site fragments and `llm.defaultProvider.connectionName` are NOT
// touched: call-site overrides become model-only together with the
// resolver's tweak blocks (one coherent change, later), and the default
// provider keeps its closed vendor enum, so its binding needs its own
// design before it can collapse.
//
// The identity mapping and managed-routable set are frozen snapshots
// (migrations are self-contained): openai/anthropic/gemini/fireworks/
// together as of 2026-08-10. A provider outside the snapshot takes the
// conservative keep-provider path.

const ROUTING_IDENTITIES = new Set(["vellum", "chatgpt"]);
const MANAGED_ROUTABLE = new Set([
  "openai",
  "anthropic",
  "gemini",
  "fireworks",
  "together",
]);

export const collapseProfileBindingsToEntriesMigration: WorkspaceMigration = {
  id: "145-collapse-profile-bindings-to-entries",
  description:
    "Fold llm.profiles.*.provider_connection into provider as connection entry names",
  retryFailedCheckpoint: true,
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

    const llm = asObject(config.llm);
    const profiles = llm === null ? null : asObject(llm.profiles);
    if (profiles === null) {
      return;
    }

    const bindings = Object.values(profiles).some((value) => {
      const entry = asObject(value);
      return (
        entry !== null &&
        typeof entry.provider_connection === "string" &&
        entry.provider_connection.length > 0
      );
    });
    if (!bindings) {
      return;
    }

    // Bindings exist, so the rewrite needs the rows. An unreadable DB must
    // fail the run (retried next boot) rather than checkpoint a pass that
    // would take the destructive dangling path for every binding.
    const rows = readConnectionRows(workspaceDir);
    if (rows === null) {
      throw new Error(
        "provider_connections is not readable; retrying the binding collapse on the next run",
      );
    }

    let changed = false;
    for (const [key, value] of Object.entries(profiles)) {
      const entry = asObject(value);
      if (entry === null) {
        continue;
      }
      const binding = entry.provider_connection;
      if (typeof binding !== "string" || binding.length === 0) {
        continue;
      }
      const provider =
        typeof entry.provider === "string" ? entry.provider : undefined;

      if (provider !== undefined && ROUTING_IDENTITIES.has(provider)) {
        delete entry.provider_connection;
        changed = true;
        log.info(
          { profile: key, provider, binding },
          "Deleted stray binding on a routing-identity profile",
        );
        continue;
      }

      if (binding === provider) {
        delete entry.provider_connection;
        changed = true;
        log.info(
          { profile: key, provider },
          "Deleted self-referential binding (bare vendor means the default entry)",
        );
        continue;
      }

      const rowKind = rows.get(binding);
      if (rowKind === undefined) {
        delete entry.provider_connection;
        changed = true;
        log.warn(
          { profile: key, provider, binding, reason: "row_missing" },
          "Deleted dangling binding; profile keeps its declared provider",
        );
        continue;
      }

      if (!kindAgrees(rowKind, provider)) {
        delete entry.provider_connection;
        changed = true;
        log.warn(
          { profile: key, provider, binding, rowKind, reason: "kind_mismatch" },
          "Deleted kind-disagreeing binding; profile keeps its declared provider",
        );
        continue;
      }

      entry.provider = binding;
      delete entry.provider_connection;
      changed = true;
      log.info(
        { profile: key, previousProvider: provider, entry: binding },
        "Folded profile binding into provider as an entry name",
      );
    }

    if (changed) {
      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    }
  },
  down(_workspaceDir: string): void {
    // Forward-only.
  },
};

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Whether a row of `rowKind` can serve a profile declaring `provider`,
 * mirroring dispatch's identity mapping. An undeclared provider agrees with
 * any row: the entry alone defines the route.
 */
function kindAgrees(rowKind: string, provider: string | undefined): boolean {
  if (provider === undefined) {
    return true;
  }
  if (rowKind === provider) {
    return true;
  }
  if (rowKind === "chatgpt") {
    return provider === "openai";
  }
  if (rowKind === "vellum") {
    return MANAGED_ROUTABLE.has(provider);
  }
  return false;
}

/**
 * Connection name -> provider kind, or null when the DB or table is not
 * readable. The caller fails the run on null: bindings must be judged
 * against real rows, never guessed.
 */
function readConnectionRows(workspaceDir: string): Map<string, string> | null {
  const dbPath = join(workspaceDir, "data", "db", "assistant.db");
  if (!existsSync(dbPath)) {
    return null;
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

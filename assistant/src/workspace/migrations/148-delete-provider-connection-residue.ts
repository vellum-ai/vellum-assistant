import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { getLogger } from "../../util/logger.js";
import type { WorkspaceMigration } from "./types.js";

const log = getLogger("migrations/148-delete-provider-connection-residue");

// The `provider_connection` config field is gone: the entry name in
// `provider` is the only routing axis, and the schema strips the field on
// every parse. This migration removes the last on-disk residue from
// `llm.default` and every `llm.profiles.*` entry so nothing keeps carrying
// a key no reader consults.
//
// Anything still holding the field here is a pin migration 145 could not
// verify at its run time (or a config written by an older build after 145
// ran). The 145 fold is attempted once more against the CURRENT
// provider_connections table:
// - A binding whose row EXISTS and whose kind AGREES with the declared
//   provider folds into `provider` (the entry name) and the field is
//   deleted. Kind agreement mirrors dispatch: same provider, a "chatgpt"
//   row for a declared "openai", or a "vellum" row for a declared
//   managed-routable provider.
// - A binding literally named "vellum"/"chatgpt" folds into the routing
//   IDENTITY value only when the identity can serve the entry's model
//   (the read-path schema strips an unroutable pair); otherwise the field
//   is deleted with a structured warn.
// - Everything else (row missing, kind disagreement, unreadable table) is
//   this recovery's end state: the field is deleted with a structured warn
//   `{ profile, provider, binding, reason: "dangling_binding_dropped" }`
//   and the entry keeps its declared provider.
// - A binding equal to the declared provider is a plain delete: the bare
//   vendor value already means the default entry of that kind.
//
// Idempotent: a config without the field is untouched. Forward-only.
//
// The identity mapping, managed-routable set, and identity model tables are
// frozen snapshots (migrations are self-contained), copied from migration
// 145 (as of 2026-08-10).

const ROUTING_IDENTITIES = new Set(["vellum", "chatgpt"]);
const MANAGED_ROUTABLE = new Set([
  "openai",
  "anthropic",
  "gemini",
  "fireworks",
  "together",
]);

const VELLUM_ROUTABLE_MODELS = new Set([
  "claude-fable-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5-20250929",
  "claude-opus-4-5-20251101",
  "claude-haiku-4-5-20251001",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-5.4",
  "gpt-5.2",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-pro-preview",
  "gemini-3.1-pro-preview-customtools",
  "gemini-3-flash-preview",
  "gemini-3.1-flash-lite-preview",
  "gemini-3.1-flash-lite",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.5-pro",
  "accounts/fireworks/models/kimi-k3",
  "accounts/fireworks/models/kimi-k2p6",
  "accounts/fireworks/models/glm-5p2",
  "accounts/fireworks/models/minimax-m3",
  "accounts/fireworks/models/minimax-m2p7",
  "accounts/fireworks/models/deepseek-v4-pro",
  "accounts/fireworks/models/deepseek-v4-flash",
  "MiniMaxAI/MiniMax-M3",
]);
const CODEX_MODELS = new Set([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
]);

function identitySafeModel(identity: string, model: unknown): boolean {
  if (typeof model !== "string") {
    return false;
  }
  return identity === "vellum"
    ? VELLUM_ROUTABLE_MODELS.has(model)
    : CODEX_MODELS.has(model);
}

export const deleteProviderConnectionResidueMigration: WorkspaceMigration = {
  id: "148-delete-provider-connection-residue",
  description:
    "Delete provider_connection from llm.default and llm.profiles.*, folding verifiable pins into provider",
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
    if (llm === null) {
      return;
    }

    const entries: Array<[string, Record<string, unknown>]> = [];
    const dflt = asObject(llm.default);
    if (dflt !== null) {
      entries.push(["<llm.default>", dflt]);
    }
    const profiles = asObject(llm.profiles);
    if (profiles !== null) {
      for (const [key, value] of Object.entries(profiles)) {
        const entry = asObject(value);
        if (entry !== null) {
          entries.push([key, entry]);
        }
      }
    }

    const carriers = entries.filter(([, entry]) =>
      Object.hasOwn(entry, "provider_connection"),
    );
    if (carriers.length === 0) {
      return;
    }

    // The end state is field-free regardless, so an unreadable DB or a
    // missing table is not a retry: every binding it would have verified
    // drops as dangling instead.
    const rows = readConnectionRows(workspaceDir);

    for (const [key, entry] of carriers) {
      const binding = entry.provider_connection;
      delete entry.provider_connection;
      if (typeof binding !== "string" || binding.length === 0) {
        continue;
      }
      const provider =
        typeof entry.provider === "string" ? entry.provider : undefined;

      if (provider !== undefined && ROUTING_IDENTITIES.has(provider)) {
        log.info(
          { profile: key, provider, binding },
          "Deleted stray binding on a routing-identity profile",
        );
        continue;
      }

      if (binding === provider) {
        log.info(
          { profile: key, provider },
          "Deleted self-referential binding (bare vendor means the default entry)",
        );
        continue;
      }

      if (ROUTING_IDENTITIES.has(binding)) {
        // Folding writes the identity VALUE itself; gate on the model the
        // identity can serve, or the read-path schema would strip the
        // profile.
        if (identitySafeModel(binding, entry.model)) {
          entry.provider = binding;
          log.info(
            { profile: key, previousProvider: provider, identity: binding },
            "Folded canonical binding into the routing identity",
          );
        } else {
          log.warn(
            {
              profile: key,
              provider,
              binding,
              reason: "dangling_binding_dropped",
            },
            "Dropped binding the identity cannot serve; profile keeps its declared provider",
          );
        }
        continue;
      }

      const rowKind = rows.get(binding);
      if (rowKind !== undefined && kindAgrees(rowKind, provider)) {
        entry.provider = binding;
        log.info(
          { profile: key, previousProvider: provider, entry: binding },
          "Folded profile binding into provider as an entry name",
        );
        continue;
      }

      log.warn(
        { profile: key, provider, binding, reason: "dangling_binding_dropped" },
        "Dropped unverifiable binding; profile keeps its declared provider",
      );
    }

    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  },
  down(_workspaceDir: string): void {
    // Forward-only: the deleted field has no readers to restore it for.
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
 * Connection name -> provider kind. An absent, unreadable, or unqueryable
 * DB yields an empty map: with no rows to verify against, every binding is
 * dangling, which is exactly the drop path.
 */
function readConnectionRows(workspaceDir: string): Map<string, string> {
  const dbPath = join(workspaceDir, "data", "db", "assistant.db");
  if (!existsSync(dbPath)) {
    return new Map();
  }
  let db: Database;
  try {
    db = new Database(dbPath);
  } catch {
    return new Map();
  }
  try {
    const rows = db
      .query(`SELECT name, provider FROM provider_connections`)
      .all() as Array<{ name: string; provider: string }>;
    return new Map(rows.map((r) => [r.name, r.provider]));
  } catch {
    return new Map();
  } finally {
    db.close();
  }
}

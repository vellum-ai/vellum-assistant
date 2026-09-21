import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import type { WorkspaceMigration } from "./types.js";

/**
 * Move TypeSafe out of `llm.profiles` and `provider_connections` into
 * `services.classification`.
 *
 * A profile is a TypeSafe profile when its `provider` is the literal
 * `"typesafe"` or names a `provider_connections` row of that kind (an
 * entry-name binding). For a config holding at least one:
 *
 *   - `services.classification` is written as the BYOK route on the first
 *     such profile's model unless the block already exists. When that
 *     profile's connection row kept its key under a custom credential
 *     account, the account is carried over as `credential`, so the key
 *     stays reachable after the row is gone.
 *   - Every TypeSafe profile is deleted.
 *   - A mix that loses arms is repaired: with two or more left it keeps
 *     them; with one left it collapses, and every reference to the mix is
 *     rewritten to that survivor; with none left it is deleted like a
 *     TypeSafe profile. Repairs cascade until no mix names a deleted or
 *     collapsed profile.
 *   - References to deleted profiles are dropped from `activeProfile`,
 *     `advisorProfile`, and each call site's `profile`, `fallbackProfile`,
 *     and `mix`; a call-site entry left empty is removed.
 *
 * The TypeSafe connection rows are deleted last, after the config has been
 * judged against them; the classification family reads the `typesafe`
 * credential slot directly and never dispatches through a row. This runs as
 * a workspace migration rather than a persistence one because persistence
 * migrations run first at startup and would remove the rows before the
 * config could be read. The run fails and is retried on the next start when
 * the database cannot be read or written.
 *
 * Idempotent: a config with no TypeSafe profile has nothing to rewrite, and
 * a second run finds no rows to delete.
 */
const TYPESAFE_PROVIDER = "typesafe";
const DEFAULT_CLASSIFICATION_MODEL = "jev-latest";
const CANONICAL_TYPESAFE_CREDENTIAL = "credential/typesafe/api_key";

interface ConnectionRow {
  provider: string;
  /** Vault-key form of an api_key row's credential account, when it has one. */
  credential?: string;
}

export const moveTypesafeProfilesToClassificationMigration: WorkspaceMigration =
  {
    id: "158-move-typesafe-profiles-to-classification",
    description:
      "Move llm.profiles that route to TypeSafe into services.classification, repair their references, and delete TypeSafe provider_connections rows",
    retryFailedCheckpoint: true,
    run(workspaceDir: string): void {
      const configPath = join(workspaceDir, "config.json");
      if (!existsSync(configPath)) {
        return;
      }

      let config: Record<string, unknown>;
      try {
        config = JSON.parse(readFileSync(configPath, "utf8")) as Record<
          string,
          unknown
        >;
      } catch {
        // A config that does not parse is the loader's problem to report, not
        // this migration's to guess at.
        return;
      }

      const connectionRows = readConnectionRows(workspaceDir);
      if (connectionRows === null) {
        throw new Error(
          "provider_connections is not readable; retrying the TypeSafe profile move on the next run",
        );
      }

      const llm = asRecord(config.llm);
      const profiles = asRecord(llm?.profiles);
      if (llm && profiles) {
        moveProfiles(config, llm, profiles, connectionRows);
        writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
      }

      if (!deleteTypesafeConnections(workspaceDir)) {
        throw new Error(
          "provider_connections is not writable; retrying the TypeSafe row deletion on the next run",
        );
      }
    },

    down(_workspaceDir: string): void {
      // Forward-only: "typesafe" is not an LLM provider, so a restored
      // profile would fail the loader's provider check.
    },
  };

function moveProfiles(
  config: Record<string, unknown>,
  llm: Record<string, unknown>,
  profiles: Record<string, unknown>,
  connectionRows: ReadonlyMap<string, ConnectionRow>,
): void {
  const removed = new Set<string>();
  let model: string = DEFAULT_CLASSIFICATION_MODEL;
  let credential: string | undefined;
  for (const [name, value] of Object.entries(profiles)) {
    const profile = asRecord(value);
    const provider = profile?.provider;
    const routesToTypesafe =
      provider === TYPESAFE_PROVIDER ||
      (typeof provider === "string" &&
        connectionRows.get(provider)?.provider === TYPESAFE_PROVIDER);
    if (!routesToTypesafe) {
      continue;
    }
    if (removed.size === 0) {
      if (typeof profile?.model === "string" && profile.model) {
        model = profile.model;
      }
      // The row a literal-provider profile dispatched through is named by
      // its binding; an entry-name profile names the row directly.
      const rowName =
        provider === TYPESAFE_PROVIDER
          ? profile?.provider_connection
          : provider;
      const rowCredential =
        typeof rowName === "string"
          ? connectionRows.get(rowName)?.credential
          : undefined;
      if (rowCredential && rowCredential !== CANONICAL_TYPESAFE_CREDENTIAL) {
        credential = rowCredential;
      }
    }
    removed.add(name);
    delete profiles[name];
  }
  if (removed.size === 0) {
    return;
  }

  const services = asRecord(config.services) ?? {};
  if (asRecord(services.classification) === null) {
    services.classification = {
      mode: "your-own",
      provider: TYPESAFE_PROVIDER,
      model,
      ...(credential ? { credential } : {}),
    };
  }
  config.services = services;

  const collapsed = repairProfileMixes(profiles, removed);
  const resolve = referenceResolver(collapsed, removed);

  for (const key of ["activeProfile", "advisorProfile"]) {
    const target = llm[key];
    if (typeof target !== "string") {
      continue;
    }
    const resolved = resolve(target);
    if (resolved === undefined) {
      delete llm[key];
    } else if (resolved !== target) {
      llm[key] = resolved;
    }
  }

  const callSites = asRecord(llm.callSites);
  if (callSites) {
    for (const [site, value] of Object.entries(callSites)) {
      const entry = asRecord(value);
      if (!entry) {
        continue;
      }
      for (const key of ["profile", "fallbackProfile"]) {
        const target = entry[key];
        if (typeof target !== "string") {
          continue;
        }
        const resolved = resolve(target);
        if (resolved === undefined) {
          delete entry[key];
        } else if (resolved !== target) {
          entry[key] = resolved;
        }
      }
      const survivor = repairMixArms(entry, resolve);
      if (survivor !== undefined && typeof entry.profile !== "string") {
        entry.profile = survivor;
      }
      if (Object.keys(entry).length === 0) {
        delete callSites[site];
      }
    }
  }
}

/**
 * Repair every mix profile against `removed`, cascading until stable.
 * Returns the collapse map (mix name -> sole surviving arm's profile);
 * mixes with no arms left are added to `removed` and deleted.
 */
function repairProfileMixes(
  profiles: Record<string, unknown>,
  removed: Set<string>,
): Map<string, string> {
  const collapsed = new Map<string, string>();
  const resolve = referenceResolver(collapsed, removed);

  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, value] of Object.entries(profiles)) {
      const profile = asRecord(value);
      if (!profile || !Array.isArray(profile.mix)) {
        continue;
      }
      const before = JSON.stringify(profile.mix);
      const survivor = repairMixArms(profile, resolve);
      if (survivor !== undefined) {
        collapsed.set(name, survivor);
        delete profiles[name];
        changed = true;
      } else if (!Array.isArray(profile.mix)) {
        removed.add(name);
        delete profiles[name];
        changed = true;
      } else if (JSON.stringify(profile.mix) !== before) {
        changed = true;
      }
    }
  }
  return collapsed;
}

/**
 * Rewrite or drop the arms of `entry.mix` through `resolve`. Returns the
 * sole survivor's profile name when exactly one arm is left (the mix is
 * removed from the entry), otherwise `undefined`; a mix with no arms left
 * is removed too.
 */
function repairMixArms(
  entry: Record<string, unknown>,
  resolve: (name: string) => string | undefined,
): string | undefined {
  if (!Array.isArray(entry.mix)) {
    return undefined;
  }
  const kept: unknown[] = [];
  for (const arm of entry.mix) {
    const record = asRecord(arm);
    if (typeof record?.profile !== "string") {
      kept.push(arm);
      continue;
    }
    const resolved = resolve(record.profile);
    if (resolved === undefined) {
      continue;
    }
    kept.push(
      resolved === record.profile ? arm : { ...record, profile: resolved },
    );
  }
  if (kept.length === 0) {
    delete entry.mix;
    return undefined;
  }
  if (kept.length === 1) {
    delete entry.mix;
    const only = asRecord(kept[0]);
    return typeof only?.profile === "string" ? only.profile : undefined;
  }
  entry.mix = kept;
  return undefined;
}

/**
 * Delete the TypeSafe rows. Returns false when the database exists but
 * cannot be opened or written; a workspace without a database or without
 * the table (pre-migration-243) has nothing to delete.
 */
function deleteTypesafeConnections(workspaceDir: string): boolean {
  const dbPath = join(workspaceDir, "data", "db", "assistant.db");
  if (!existsSync(dbPath)) {
    return true;
  }
  let db: Database;
  try {
    db = new Database(dbPath);
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
      return true;
    }
    db.prepare(`DELETE FROM provider_connections WHERE provider = ?`).run(
      TYPESAFE_PROVIDER,
    );
    return true;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

/**
 * Connection name -> row, or null when the database or table is not
 * readable. A missing database means a workspace with no connections.
 */
function readConnectionRows(
  workspaceDir: string,
): Map<string, ConnectionRow> | null {
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
    const tableExists = db
      .query(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'provider_connections'`,
      )
      .get();
    if (!tableExists) {
      return new Map();
    }
    const rows = db
      .query(`SELECT name, provider, auth FROM provider_connections`)
      .all() as Array<{ name: string; provider: string; auth: string }>;
    return new Map(
      rows.map((row) => [
        row.name,
        { provider: row.provider, credential: credentialOf(row.auth) },
      ]),
    );
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/**
 * Map a profile reference through collapsed mixes to the profile it now
 * means, or `undefined` when it ends on a deleted profile.
 */
function referenceResolver(
  collapsed: ReadonlyMap<string, string>,
  removed: ReadonlySet<string>,
): (name: string) => string | undefined {
  return (name) => {
    let current = name;
    const seen = new Set<string>();
    while (collapsed.has(current) && !seen.has(current)) {
      seen.add(current);
      current = collapsed.get(current)!;
    }
    return removed.has(current) ? undefined : current;
  };
}

/**
 * The vault-key credential account of an api_key auth payload, in the same
 * normalization the credential store applies (`service:field` on the wire
 * becomes `credential/service/field`). Inlined so the migration keeps
 * behaving identically if the shared helper ever changes.
 */
function credentialOf(auth: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(auth);
  } catch {
    return undefined;
  }
  const record = asRecord(parsed);
  if (record?.type !== "api_key" || typeof record.credential !== "string") {
    return undefined;
  }
  const ref = record.credential;
  if (ref.startsWith("credential/")) {
    return ref;
  }
  const colon = ref.lastIndexOf(":");
  if (colon < 1 || colon === ref.length - 1) {
    return ref;
  }
  return `credential/${ref.slice(0, colon)}/${ref.slice(colon + 1)}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

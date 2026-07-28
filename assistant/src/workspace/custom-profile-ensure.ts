import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { invalidateConfigCache } from "../config/loader.js";
import { completeCustomProfile } from "../config/profile-materialization.js";
import { LLMConfigBase, ProfileEntry } from "../config/schemas/llm.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("custom-profile-ensure");

// Materializes partial custom profiles into complete overrides on every boot.
//
// This is a boot ensure pass rather than a workspace migration because
// completion needs the live model catalog: a model-only profile takes the
// provider `completeCustomProfile` implies from the catalog, and migrations
// are frozen self-contained snapshots that may not import it (see
// workspace/migrations/AGENTS.md). Using the live helper keeps this pass and
// the write-path normalization in `commitConfigWrite` identical by
// construction. Running unconditionally each boot (the
// `ensureDefaultProvider` pattern) also covers configs restored from backups
// and entries injected after the migration registry checkpoints — and it
// completes before the first `loadConfig()`, so no resolution ever sees a
// partial custom profile.
//
// Idempotent and write-avoidant: entries that are already complete (and mix
// profiles, managed-source entries, and entries that do not parse as a
// `ProfileEntry`) are left byte-identical; the file is rewritten only when
// at least one entry changed. Unknown keys on an entry survive completion.
// Each materialized profile logs the exact fields it baked so a later
// resolution report can be attributed to baked data vs. resolver semantics.
export function ensureCompleteCustomProfiles(workspaceDir: string): void {
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

  const llm = readObject(config.llm);
  if (llm === null) {
    return;
  }
  const profiles = readObject(llm.profiles);
  if (profiles === null) {
    return;
  }
  const parsedDefault = LLMConfigBase.safeParse(llm.default ?? {});
  if (!parsedDefault.success) {
    return;
  }

  let changed = false;
  for (const [name, rawEntry] of Object.entries(profiles)) {
    const entry = readObject(rawEntry);
    if (entry === null) {
      continue;
    }
    const parsed = ProfileEntry.safeParse(entry);
    if (!parsed.success) {
      continue;
    }
    // Merge over the original raw entry at every depth so keys the schema
    // doesn't know survive (`safeParse` strips them, top-level and inside
    // nested objects like `contextWindow`).
    const merged: Record<string, unknown> = mergePreservingUnknownKeys(
      entry,
      completeCustomProfile(parsedDefault.data, parsed.data) as Record<
        string,
        unknown
      >,
    );
    if (isDeepStrictEqual(merged, entry)) {
      continue;
    }
    const bakedFields = Object.keys(merged).filter(
      (key) => !(key in entry) || !isDeepStrictEqual(merged[key], entry[key]),
    );
    profiles[name] = merged;
    changed = true;
    log.info(
      { profile: name, bakedFields },
      "Materialized partial custom profile into a complete override",
    );
  }

  if (!changed) {
    return;
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  // The lifecycle call site runs before the first loadConfig() of this boot;
  // this guards callers that read config earlier (and future reordering).
  invalidateConfigCache();
}

/**
 * `{...raw, ...completed}` recursively: completed (schema-known) values win,
 * raw keys the schema stripped survive at every depth. (Duplicated in the
 * write-path normalization in conversation-query-routes.ts — the two land in
 * independent PRs; consolidate when either next changes.)
 */
function mergePreservingUnknownKeys(
  raw: Record<string, unknown>,
  completed: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw, ...completed };
  for (const [key, value] of Object.entries(completed)) {
    const rawValue = raw[key];
    if (readObject(value) !== null && readObject(rawValue) !== null) {
      out[key] = mergePreservingUnknownKeys(
        rawValue as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    }
  }
  return out;
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

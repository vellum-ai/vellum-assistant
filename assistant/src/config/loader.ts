import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { getLogger } from "../util/logger.js";
import { ensureDataDir, getWorkspaceConfigPath } from "../util/platform.js";
import { isAssistantFeatureFlagEnabled } from "./assistant-feature-flags.js";
import { AssistantConfigSchema } from "./schema.js";
import type { AssistantConfig } from "./types.js";

export { API_KEY_PROVIDERS } from "../providers/provider-secret-catalog.js";

const log = getLogger("config");

let cached: AssistantConfig | null = null;
let loading = false;

function getConfigPath(): string {
  return getWorkspaceConfigPath();
}

function ensureMigratedDataDir(): void {
  ensureDataDir();
}

/**
 * Parse a raw config through the Zod schema, applying all nested defaults.
 *
 * All nested object schemas use `.default(SubSchema.parse({}))` which
 * pre-computes fully-resolved defaults at schema construction time, so a
 * single parse is sufficient to cascade defaults through every nesting level.
 */
export function applyNestedDefaults(config: unknown): AssistantConfig {
  return structuredClone(
    AssistantConfigSchema.parse(config),
  ) as AssistantConfig;
}

function cloneDefaultConfig(): AssistantConfig {
  return applyNestedDefaults({});
}

/**
 * Build a filesystem-safe ISO-8601 timestamp for use in quarantine filenames.
 * Replaces `:` (invalid on Windows, confusing on macOS Finder) with `-` so the
 * resulting string is safe on every supported platform.
 */
function filesystemSafeTimestamp(date: Date = new Date()): string {
  return date.toISOString().replace(/:/g, "-");
}

/**
 * Rename a corrupt config file to a quarantine path so the bad content is
 * preserved for debug while the daemon falls through to defaults. Logs at
 * `error` level with a remediation hint. Best-effort: if the rename itself
 * fails (missing permissions, readonly FS, etc.) we still fall through to
 * defaults — startup must never block.
 *
 * The quarantine filename encodes a millisecond-precision timestamp and ends
 * in `.json` so editors syntax-highlight the preserved content:
 *   `<path>.corrupt-<ISO-timestamp>.json`
 */
function quarantineCorruptConfig(configPath: string, err: unknown): string {
  const quarantinePath = `${configPath}.corrupt-${filesystemSafeTimestamp()}.json`;
  try {
    renameSync(configPath, quarantinePath);
    log.error(
      `config file at ${configPath} was corrupt (${String(err)}); ` +
        `quarantined to ${quarantinePath} and loaded defaults. ` +
        `Inspect the quarantined file to recover any hand-edited settings.`,
    );
  } catch (renameErr) {
    log.error(
      { renameErr },
      `config file at ${configPath} was corrupt (${String(err)}) but could ` +
        `not be renamed for quarantine; loaded defaults.`,
    );
  }
  return quarantinePath;
}

/**
 * Validate a raw config object with Zod. Invalid fields are logged as warnings
 * and replaced with defaults (matching prior behavior of per-field fallback).
 */
function validateWithSchema(raw: Record<string, unknown>): AssistantConfig {
  const result = AssistantConfigSchema.safeParse(raw);
  if (result.success) {
    return applyNestedDefaults(result.data);
  }

  // Log each validation issue as a warning
  for (const issue of result.error.issues) {
    const path = issue.path.join(".");
    log.warn(
      `Invalid config${path ? ` at "${path}"` : ""}: ${
        issue.message
      }. Falling back to default.`,
    );
  }

  // Strip invalid fields by setting them to undefined so Zod defaults apply,
  // then re-parse. We walk the error paths and delete the offending keys.
  const cleaned = structuredClone(raw);
  for (const issue of result.error.issues) {
    if (issue.path.length === 0) {
      // Top-level error — return full defaults
      return cloneDefaultConfig();
    }
    deleteNestedKey(cleaned, issue.path as (string | number)[]);
  }

  const retry = AssistantConfigSchema.safeParse(cleaned);
  if (retry.success) {
    return applyNestedDefaults(retry.data);
  }

  // If still failing, fall back to full defaults
  log.warn("Config validation failed after cleanup. Using full defaults.");
  return cloneDefaultConfig();
}

function deleteNestedKey(
  obj: Record<string, unknown>,
  path: (string | number)[],
): void {
  let current: unknown = obj;
  for (let i = 0; i < path.length - 1; i++) {
    if (current == null || typeof current !== "object") return;
    current = (current as Record<string, unknown>)[String(path[i])];
  }
  if (current != null && typeof current === "object") {
    delete (current as Record<string, unknown>)[String(path[path.length - 1])];
  }
}

/**
 * Deprecated config fields that have been removed. Each entry maps a
 * dot-separated path to the deprecation message shown to the user.
 */
const DEPRECATED_FIELDS: Record<string, string> = {
  "rateLimit.maxTokensPerSession":
    "rateLimit.maxTokensPerSession has been removed and is no longer enforced. " +
    "Per-session token budget tracking is no longer supported. " +
    "The field will be removed from your config file.",
  providerOrder:
    "providerOrder has been removed from the config schema. " +
    "Provider selection is now handled automatically. " +
    "The field will be removed from your config file.",
  "permissions.dangerouslySkipPermissions":
    "permissions.dangerouslySkipPermissions has been removed. " +
    "Permission prompts are now always shown when required. " +
    "The field will be removed from your config file.",
};

/**
 * Check for deprecated config fields, log a warning for each one found,
 * and strip them from both the in-memory object and the on-disk config file
 * so the warning is only emitted once.
 */
function warnAndStripDeprecatedFields(
  fileConfig: Record<string, unknown>,
  configPath: string,
): void {
  const found: string[] = [];
  for (const dotPath of Object.keys(DEPRECATED_FIELDS)) {
    if (getNestedValue(fileConfig, dotPath) !== undefined) {
      log.warn(DEPRECATED_FIELDS[dotPath]);
      found.push(dotPath);
    }
  }

  if (found.length === 0) return;

  // Strip from the in-memory object so Zod never sees them
  for (const dotPath of found) {
    deleteNestedKeyByDotPath(fileConfig, dotPath);
  }

  // Persist the cleaned config to disk so the warning doesn't repeat
  try {
    if (existsSync(configPath)) {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      if (raw != null && typeof raw === "object" && !Array.isArray(raw)) {
        for (const dotPath of found) {
          deleteNestedKeyByDotPath(raw as Record<string, unknown>, dotPath);
        }
        writeFileSync(configPath, JSON.stringify(raw, null, 2) + "\n");
      }
    }
  } catch {
    // Best-effort — if the file can't be rewritten, the warning will repeat
    // on next load, which is acceptable.
  }
}

function deleteNestedKeyByDotPath(
  obj: Record<string, unknown>,
  dotPath: string,
): void {
  const keys = dotPath.split(".");
  deleteNestedKey(obj, keys);
}

/**
 * Deep-merge missing keys from `defaults` into `target`.
 * Only adds keys that do not already exist in `target`; never overwrites.
 * Returns true if any key was added.
 */
export function deepMergeMissing(
  target: Record<string, unknown>,
  defaults: Record<string, unknown>,
): boolean {
  let changed = false;
  for (const key of Object.keys(defaults)) {
    if (!(key in target)) {
      target[key] = defaults[key];
      changed = true;
    } else if (
      defaults[key] != null &&
      typeof defaults[key] === "object" &&
      !Array.isArray(defaults[key]) &&
      target[key] != null &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      // Recurse into nested objects
      if (
        deepMergeMissing(
          target[key] as Record<string, unknown>,
          defaults[key] as Record<string, unknown>,
        )
      ) {
        changed = true;
      }
    }
  }
  return changed;
}

/**
 * Recursively strip `null` leaves from a plain-object value, returning a
 * deep clone with all `null`-valued keys removed at every nesting level.
 * Non-object inputs (scalars, arrays, `null` itself) are returned as-is.
 *
 * Used to sanitize `overrides` before assigning whole subtrees in
 * `deepMergeOverwrite`, so deletion-sentinel semantics apply uniformly
 * even when the corresponding `target` key does not yet exist.
 */
function stripNullLeaves(value: unknown): unknown {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === null) continue;
    out[k] = stripNullLeaves(v);
  }
  return out;
}

/**
 * Deep-merge `overrides` into `target`, overwriting leaf values.
 * Recursively merges nested objects; scalars and arrays from `overrides`
 * replace corresponding values in `target`.
 *
 * JSON `null` semantics depend on what the target currently holds at
 * that key:
 *
 * - **Target holds a non-null object** (not array): `null` deletes the
 *   key, removing the entire subtree. This supports "clear entry"
 *   semantics (e.g. the macOS SettingsStore clearing a call-site
 *   override via `{ callSites: { memoryRetrieval: null } }`).
 *
 * - **Target holds a scalar, null, or array**: `null` is assigned as the
 *   value, preserving nullable config fields like `activeHoursStart`
 *   and `llmRequestLogRetentionMs` where `null` is a valid schema
 *   value meaning "disabled / no limit".
 *
 * - **Key absent from target**: no-op. Assigning null to a missing key
 *   would create a spurious entry; callers that want to establish a
 *   null value should set the key to its default first.
 *
 * When an override assigns a whole object subtree to a key that does
 * not yet exist on `target` (or whose existing value is a scalar/array),
 * `stripNullLeaves` drops any `null` leaves inside that subtree before
 * assignment so no invalid nulls get persisted for non-nullable fields.
 */
export function deepMergeOverwrite(
  target: Record<string, unknown>,
  overrides: Record<string, unknown>,
): void {
  for (const key of Object.keys(overrides)) {
    const ov = overrides[key];
    if (ov === null) {
      if (!(key in target)) continue;
      const existing = target[key];
      if (
        existing != null &&
        typeof existing === "object" &&
        !Array.isArray(existing)
      ) {
        delete target[key];
      } else {
        target[key] = null;
      }
    } else if (
      ov !== undefined &&
      typeof ov === "object" &&
      !Array.isArray(ov) &&
      target[key] != null &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      deepMergeOverwrite(
        target[key] as Record<string, unknown>,
        ov as Record<string, unknown>,
      );
    } else {
      target[key] = stripNullLeaves(ov);
    }
  }
}

/**
 * Read the existing config.json from disk, merge any missing schema-default
 * keys, and rewrite only when there is an effective change.
 */
function backfillConfigDefaults(
  configPath: string,
  fullDefaults: Record<string, unknown>,
): void {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return; // Unreadable file — skip backfill
  }

  // Only backfill into plain objects (not arrays, strings, etc.)
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return;
  }

  deepMergeMissing(raw as Record<string, unknown>, fullDefaults);
  // Compare serialized JSON to decide whether a write is needed.
  // deepMergeMissing can report false-positive mutations (e.g. setting a key
  // to a value identical to what was already there), so comparing the final
  // JSON avoids a hot-loop where writing triggers the config-watcher which
  // reloads and backfills again endlessly.
  const newJson = JSON.stringify(raw, null, 2) + "\n";
  const existingJson = readFileSync(configPath, "utf-8");
  if (newJson !== existingJson) {
    writeFileSync(configPath, newJson);
    log.info("Backfilled missing config defaults in %s", configPath);
  }
}

/**
 * Merge default workspace config from the file referenced by
 * VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH into the workspace config on disk.
 *
 * Called once at daemon startup (before the first loadConfig()) so the
 * defaults are persisted to the workspace config file alongside any
 * schema-level defaults that loadConfig() backfills.
 */
export function mergeDefaultWorkspaceConfig(): void {
  const defaultConfigPath = process.env.VELLUM_DEFAULT_WORKSPACE_CONFIG_PATH;
  if (!defaultConfigPath || !existsSync(defaultConfigPath)) return;

  let defaults: unknown;
  try {
    defaults = JSON.parse(readFileSync(defaultConfigPath, "utf-8"));
  } catch (err) {
    log.warn(
      { err },
      "Failed to read default workspace config from %s",
      defaultConfigPath,
    );
    return;
  }

  if (
    defaults == null ||
    typeof defaults !== "object" ||
    Array.isArray(defaults)
  ) {
    return;
  }

  const configPath = getConfigPath();
  let existing: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      existing = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
      // If existing config is corrupt, start fresh
    }
  }

  deepMergeOverwrite(existing, defaults as Record<string, unknown>);

  const dir = dirname(configPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(configPath, JSON.stringify(existing, null, 2) + "\n");

  // Move the temp file into the workspace directory as a permanent record.
  // This prevents re-application on daemon restart (the env var still points
  // at the old /tmp path which no longer exists).
  try {
    const dest = join(dir, "default-config.json");
    renameSync(defaultConfigPath, dest);
    log.info(
      "Merged default workspace config from %s (archived to %s)",
      defaultConfigPath,
      dest,
    );
  } catch {
    log.info("Merged default workspace config from %s", defaultConfigPath);
  }
}

export function loadConfig(): AssistantConfig {
  if (cached) return cached;

  // Re-entrancy guard: log calls during loading (e.g. file-mode warning)
  // can trigger loadConfig again. Return defaults to break the cycle
  // instead of recursing to stack overflow.
  if (loading) return cloneDefaultConfig();
  loading = true;

  try {
    ensureMigratedDataDir();
    const configPath = getConfigPath();

    let fileConfig: Record<string, unknown> = {};
    let configFileExisted = true;
    if (existsSync(configPath)) {
      const mode = statSync(configPath).mode;
      if (mode & 0o077) {
        log.warn(
          `Config file ${configPath} is readable by other users (mode ${(
            mode & 0o777
          ).toString(8)}). ` + `Run: chmod 600 ${configPath}`,
        );
      }

      try {
        fileConfig = JSON.parse(readFileSync(configPath, "utf-8"));
      } catch (err) {
        // The daemon must never block startup (assistant/CLAUDE.md). A config
        // file that fails JSON.parse — truncated during a mid-write crash, or
        // hand-edited to invalid JSON — is quarantined so the content is
        // preserved for debug, and startup proceeds with the same default-
        // config path used when config.json does not exist.
        quarantineCorruptConfig(configPath, err);
        fileConfig = {};
        configFileExisted = false;
      }
    } else {
      configFileExisted = false;
    }

    // Warn about and strip deprecated config fields so users know their
    // settings are no longer honored rather than silently dropping them.
    warnAndStripDeprecatedFields(fileConfig, configPath);

    // Validate and apply defaults via Zod schema
    let config = validateWithSchema(fileConfig);

    // Managed Gemini embedding defaults migration.
    // When on a managed platform (IS_PLATFORM=true) with the feature flag
    // enabled and no explicit embedding provider chosen (provider=auto),
    // persist Gemini embedding defaults into the raw config file.
    // Idempotent: once provider=gemini is written, subsequent loads skip this.
    if (config.memory.embeddings.provider === "auto") {
      try {
        if (
          (process.env.IS_PLATFORM === "true" ||
            process.env.IS_PLATFORM === "1") &&
          isManagedGeminiFFEnabled(config)
        ) {
          setNestedValue(fileConfig, "memory.embeddings.provider", "gemini");
          setNestedValue(
            fileConfig,
            "memory.embeddings.geminiModel",
            "gemini-embedding-2-preview",
          );
          setNestedValue(
            fileConfig,
            "memory.embeddings.geminiDimensions",
            3072,
          );
          setNestedValue(fileConfig, "memory.qdrant.vectorSize", 3072);
          writeFileSync(configPath, JSON.stringify(fileConfig, null, 2) + "\n");
          log.info(
            "Applied managed Gemini embedding defaults (provider=gemini, model=gemini-embedding-2-preview, dimensions=3072, vectorSize=3072)",
          );
          // Re-validate so the returned config reflects the migration.
          config = validateWithSchema(fileConfig);
        }
      } catch (err) {
        log.warn(
          { err },
          "Managed Gemini defaults migration failed — continuing with existing config",
        );
      }
    }

    // If the config file didn't exist, write the full defaults to disk so
    // users can discover and edit all available options.
    // If it existed, backfill any missing schema keys from defaults without
    // overwriting existing user values.
    try {
      const dir = dirname(configPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      // Strip dataDir (runtime-derived) from the persisted config
      const { dataDir: _, ...persistable } = config;

      if (!configFileExisted) {
        writeFileSync(configPath, JSON.stringify(persistable, null, 2) + "\n");
        log.info("Wrote default config to %s", configPath);
      } else {
        backfillConfigDefaults(configPath, persistable);
      }
    } catch (err) {
      log.warn({ err }, "Failed to write/backfill config file");
    }

    cached = config;

    loading = false;
    return config;
  } catch (err) {
    // Loading failed — clear cached so the next call retries
    cached = null;
    loading = false;
    throw err;
  }
}

/**
 * Check whether the managed-gemini-embeddings-enabled feature flag is on.
 * Wrapped in a try/catch so a flag-resolver failure never breaks config loading.
 */
function isManagedGeminiFFEnabled(config: AssistantConfig): boolean {
  try {
    return isAssistantFeatureFlagEnabled(
      "managed-gemini-embeddings-enabled",
      config,
    );
  } catch {
    return false;
  }
}

export function saveConfig(config: AssistantConfig): void {
  ensureMigratedDataDir();
  const configPath = getConfigPath();

  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  cached = config;
}

export function getConfig(): AssistantConfig {
  return loadConfig();
}

/**
 * Read-only config accessor: returns the current config without creating
 * directories or writing files. Reads config.json if it exists on disk;
 * returns schema defaults otherwise. Unlike `getConfig()` / `loadConfig()`,
 * this never calls `ensureDataDir()` or writes a default config to disk,
 * making it safe to call during CLI program construction before the
 * workspace-existence check runs.
 */
export function getConfigReadOnly(): AssistantConfig {
  if (cached) return cached;

  const configPath = getConfigPath();
  let fileConfig: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
      return cloneDefaultConfig();
    }
  }

  return validateWithSchema(fileConfig);
}

export function invalidateConfigCache(): void {
  cached = null;
  loading = false;
}

/**
 * Load the raw config from disk without any secure-storage merging.
 * Used by CLI config commands to read/write the file directly.
 * API keys in secure storage are managed via `assistant keys` commands.
 */
export function loadRawConfig(): Record<string, unknown> {
  ensureMigratedDataDir();
  const configPath = getConfigPath();
  let raw: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      raw = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch (err) {
      // Mirror loadConfig(): quarantine the corrupt file and return an empty
      // object rather than throwing. This prevents /v1/config from surfacing
      // a 500 when the user's config.json is malformed.
      quarantineCorruptConfig(configPath, err);
      raw = {};
    }
  }

  return raw;
}

export function saveRawConfig(config: Record<string, unknown>): void {
  ensureMigratedDataDir();
  const configPath = getConfigPath();

  // Strip legacy apiKeys — provider keys belong in secure storage, not plaintext config
  delete config.apiKeys;

  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  cached = null; // invalidate cache
}

export function getNestedValue(
  obj: Record<string, unknown>,
  path: string,
): unknown {
  const keys = path.split(".");
  let current: unknown = obj;
  for (const key of keys) {
    if (current == null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function setNestedValue(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const keys = path.split(".");
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (current[key] == null || typeof current[key] !== "object") {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]] = value;
}

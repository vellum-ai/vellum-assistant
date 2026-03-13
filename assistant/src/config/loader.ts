import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import {
  deleteSecureKey,
  getSecureKey,
  setSecureKey,
} from "../security/secure-keys.js";
import { ConfigError } from "../util/errors.js";
import { getLogger } from "../util/logger.js";
import {
  ensureDataDir,
  getWorkspaceConfigPath,
  readLockfile,
  writeLockfile,
} from "../util/platform.js";
import { AssistantConfigSchema } from "./schema.js";
import type { AssistantConfig } from "./types.js";

const log = getLogger("config");

// Providers that store API keys in secure storage (superset of VALID_PROVIDERS)
export const API_KEY_PROVIDERS = [
  "anthropic",
  "openai",
  "gemini",
  "ollama",
  "fireworks",
  "openrouter",
  "brave",
  "perplexity",
] as const;

let cached: AssistantConfig | null = null;
let loading = false;

function getConfigPath(): string {
  return getWorkspaceConfigPath();
}

function ensureMigratedDataDir(): void {
  ensureDataDir();
}

/**
 * Zod 4's .default({}) returns {} as output without running inner-schema
 * parsing, so nested object defaults are never applied. Re-parse the config
 * to cascade defaults through each nesting level.
 * Max chain of .default({}) on object schemas is 4
 * (e.g. memory → retrieval → freshness → maxAgeDays),
 * so 5 parses are needed (N+1) to fully cascade.
 */
export function applyNestedDefaults(config: unknown): AssistantConfig {
  let current: unknown = config;
  for (let i = 0; i < 5; i++) {
    current = AssistantConfigSchema.parse(current);
  }
  return current as AssistantConfig;
}

function cloneDefaultConfig(): AssistantConfig {
  return applyNestedDefaults({});
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
 * Read the existing config.json from disk, merge any missing schema-default
 * keys, and rewrite only when there is an effective change.
 * Preserves exclusions: apiKeys and dataDir are never written.
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

export function loadConfig(): AssistantConfig {
  if (cached) return cached;

  // Re-entrancy guard: log calls during loading (e.g. file-mode warning,
  // invalid apiKeys) can trigger loadConfig again. Return defaults to
  // break the cycle instead of recursing to stack overflow.
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
        throw new ConfigError(
          `Failed to parse config at ${configPath}: ${err}`,
        );
      }
    } else {
      configFileExisted = false;
    }

    // Pre-validate apiKeys shape before migration (must be a plain object)
    if (
      fileConfig.apiKeys !== undefined &&
      (typeof fileConfig.apiKeys !== "object" ||
        fileConfig.apiKeys == null ||
        Array.isArray(fileConfig.apiKeys))
    ) {
      log.warn(
        "Invalid apiKeys in config file: must be an object with string values. Ignoring.",
      );
      delete fileConfig.apiKeys;
    }

    // Auto-migrate plaintext apiKeys from config.json to secure storage
    if (fileConfig.apiKeys && typeof fileConfig.apiKeys === "object") {
      const apiKeysObj = fileConfig.apiKeys as Record<string, unknown>;
      const plaintextKeys = Object.entries(apiKeysObj).filter(
        ([, v]) => typeof v === "string" && (v as string).length > 0,
      );
      if (plaintextKeys.length > 0) {
        const migratedProviders: string[] = [];
        for (const [provider, value] of plaintextKeys) {
          if (setSecureKey(provider, value as string)) {
            migratedProviders.push(provider);
          } else {
            log.warn(
              `Failed to migrate API key for "${provider}" to secure storage`,
            );
          }
        }
        if (migratedProviders.length > 0) {
          // Rewrite config.json without successfully migrated apiKeys
          try {
            const rawJson = JSON.parse(readFileSync(configPath, "utf-8"));
            for (const p of migratedProviders) {
              delete rawJson.apiKeys[p];
            }
            if (Object.keys(rawJson.apiKeys).length === 0) {
              delete rawJson.apiKeys;
            }
            writeFileSync(configPath, JSON.stringify(rawJson, null, 2) + "\n");
            log.info(
              `Migrated ${migratedProviders.length} API key(s) from config.json to secure storage`,
            );
          } catch (err) {
            log.warn(
              { err },
              "Failed to remove migrated keys from config.json",
            );
          }
        }
        // Clear only migrated keys from fileConfig so failed keys still flow into config
        for (const p of migratedProviders) {
          delete apiKeysObj[p];
        }
        if (Object.keys(apiKeysObj).length === 0) {
          delete fileConfig.apiKeys;
        }
      }
    }

    // Validate and apply defaults via Zod schema
    const config = validateWithSchema(fileConfig);

    // If the config file didn't exist, write the full defaults to disk so
    // users can discover and edit all available options.
    // If it existed, backfill any missing schema keys from defaults without
    // overwriting existing user values.
    try {
      const dir = dirname(configPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      // Strip apiKeys (managed in secure storage) and dataDir (runtime-derived)
      const { apiKeys: _, dataDir: _d, ...persistable } = config;

      if (!configFileExisted) {
        writeFileSync(configPath, JSON.stringify(persistable, null, 2) + "\n");
        log.info("Wrote default config to %s", configPath);
      } else {
        backfillConfigDefaults(configPath, persistable);
      }
    } catch (err) {
      log.warn({ err }, "Failed to write/backfill config file");
    }

    // Set cached before secure-key/env overrides so re-entrant calls
    // return the in-flight config instead of bare defaults.
    cached = config;

    // Secure storage keys override plaintext config file
    try {
      for (const provider of API_KEY_PROVIDERS) {
        const secureKey = getSecureKey(provider);
        if (secureKey) {
          config.apiKeys[provider] = secureKey;
        }
      }
    } catch (err) {
      log.debug({ err }, "Failed to load keys from secure storage");
    }

    // Environment variables override everything
    if (process.env.ANTHROPIC_API_KEY) {
      config.apiKeys.anthropic = process.env.ANTHROPIC_API_KEY;
    }
    if (process.env.OPENAI_API_KEY) {
      config.apiKeys.openai = process.env.OPENAI_API_KEY;
    }
    if (process.env.GEMINI_API_KEY) {
      config.apiKeys.gemini = process.env.GEMINI_API_KEY;
    }
    if (process.env.OLLAMA_API_KEY) {
      config.apiKeys.ollama = process.env.OLLAMA_API_KEY;
    }
    if (process.env.FIREWORKS_API_KEY) {
      config.apiKeys.fireworks = process.env.FIREWORKS_API_KEY;
    }
    if (process.env.OPENROUTER_API_KEY) {
      config.apiKeys.openrouter = process.env.OPENROUTER_API_KEY;
    }
    if (process.env.BRAVE_API_KEY) {
      config.apiKeys.brave = process.env.BRAVE_API_KEY;
    }
    if (process.env.PERPLEXITY_API_KEY) {
      config.apiKeys.perplexity = process.env.PERPLEXITY_API_KEY;
    }

    loading = false;
    return config;
  } catch (err) {
    // Loading failed — clear cached so the next call retries
    cached = null;
    loading = false;
    throw err;
  }
}

export function saveConfig(config: AssistantConfig): void {
  ensureMigratedDataDir();
  const configPath = getConfigPath();

  // Route apiKeys to secure storage, write config without them
  for (const [provider, value] of Object.entries(config.apiKeys)) {
    if (typeof value === "string" && value.length > 0) {
      if (!setSecureKey(provider, value)) {
        throw new ConfigError(
          `Failed to save API key for "${provider}" to secure storage`,
        );
      }
    }
  }
  // Delete secure keys for providers no longer in apiKeys or with empty values
  for (const provider of API_KEY_PROVIDERS) {
    const value = config.apiKeys[provider];
    if (!value || (typeof value === "string" && value.length === 0)) {
      deleteSecureKey(provider);
    }
  }
  const { apiKeys: _, ...rest } = config;
  writeFileSync(configPath, JSON.stringify(rest, null, 2) + "\n");

  cached = config;
}

export function getConfig(): AssistantConfig {
  return loadConfig();
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
      throw new ConfigError(`Failed to parse config at ${configPath}: ${err}`);
    }
  }

  return raw;
}

export function saveRawConfig(config: Record<string, unknown>): void {
  ensureMigratedDataDir();
  const configPath = getConfigPath();

  // Route apiKeys to secure storage and strip from plaintext file
  const apiKeys = config.apiKeys;
  if (apiKeys && typeof apiKeys === "object" && !Array.isArray(apiKeys)) {
    for (const [provider, value] of Object.entries(
      apiKeys as Record<string, unknown>,
    )) {
      if (typeof value === "string" && value.length > 0) {
        if (!setSecureKey(provider, value)) {
          throw new ConfigError(
            `Failed to save API key for "${provider}" to secure storage. Key not removed from config to prevent data loss.`,
          );
        }
      } else if (value == null || value === "") {
        deleteSecureKey(provider);
      }
    }
    // Remove apiKeys from plaintext config
    const { apiKeys: _, ...rest } = config;
    writeFileSync(configPath, JSON.stringify(rest, null, 2) + "\n");
  } else {
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  }

  cached = null; // invalidate cache
}

/**
 * Sync client-relevant config values (e.g. platform.baseUrl) to the lockfile
 * so external tools (e.g. vel) can discover them without importing the full
 * config schema.  Mirrors the behaviour of `syncConfigToLockfile` in the
 * lightweight CLI (`cli/src/lib/assistant-config.ts`).
 */
export function syncConfigToLockfile(): void {
  const configPath = getWorkspaceConfigPath();
  if (!existsSync(configPath)) return;

  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as Record<
      string,
      unknown
    >;
    const platform = raw.platform as Record<string, unknown> | undefined;
    const data = readLockfile() ?? {};
    data.platformBaseUrl = (platform?.baseUrl as string) || undefined;
    writeLockfile(data);
  } catch {
    // Config file unreadable — skip sync
  }
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

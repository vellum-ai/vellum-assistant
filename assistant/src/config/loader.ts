import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir, ensureDataDir } from '../util/platform.js';
import { ConfigError } from '../util/errors.js';
import { getLogger } from '../util/logger.js';
import { DEFAULT_CONFIG } from './defaults.js';
import type { AssistantConfig } from './types.js';

const log = getLogger('config');

const VALID_PROVIDERS = ['anthropic', 'openai', 'gemini', 'ollama'] as const;

let cached: AssistantConfig | null = null;
let loading = false;

function getConfigPath(): string {
  return join(getDataDir(), 'config.json');
}

export function loadConfig(): AssistantConfig {
  if (cached) return cached;

  // Re-entrancy guard: log calls during loading (e.g. file-mode warning,
  // invalid apiKeys) can trigger loadConfig again. Return defaults to
  // break the cycle instead of recursing to stack overflow.
  if (loading) return DEFAULT_CONFIG;
  loading = true;

  try {
    ensureDataDir();
    const configPath = getConfigPath();

    let fileConfig: Partial<AssistantConfig> = {};
    if (existsSync(configPath)) {
      const mode = statSync(configPath).mode;
      if (mode & 0o077) {
        log.warn(
          `Config file ${configPath} is readable by other users (mode ${(mode & 0o777).toString(8)}). ` +
          `Run: chmod 600 ${configPath}`,
        );
      }

      try {
        fileConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
      } catch (err) {
        throw new ConfigError(`Failed to parse config at ${configPath}: ${err}`);
      }
    }

    if (
      fileConfig.apiKeys !== undefined &&
      (typeof fileConfig.apiKeys !== 'object' || fileConfig.apiKeys === null || Array.isArray(fileConfig.apiKeys))
    ) {
      log.warn('Invalid apiKeys in config file: must be an object with string values. Ignoring.');
      delete fileConfig.apiKeys;
    }

    const config: AssistantConfig = {
      ...DEFAULT_CONFIG,
      ...fileConfig,
      apiKeys: { ...DEFAULT_CONFIG.apiKeys, ...fileConfig.apiKeys },
      timeouts: { ...DEFAULT_CONFIG.timeouts, ...(fileConfig as Record<string, unknown>).timeouts as Partial<AssistantConfig['timeouts']> },
    };

    // Set cached before validation so re-entrant calls (e.g. validateConfig
    // logging triggers loadConfig) return the in-flight config instead of
    // bare defaults. Validation mutates the same object, so callers see
    // corrected values.
    cached = config;

    validateConfig(config);

    // Environment variables override config file (after validation so apiKeys is a valid object)
    if (process.env.ANTHROPIC_API_KEY) {
      config.apiKeys.anthropic = process.env.ANTHROPIC_API_KEY;
    }
    if (process.env.OPENAI_API_KEY) {
      config.apiKeys.openai = process.env.OPENAI_API_KEY;
    }
    if (process.env.GEMINI_API_KEY) {
      config.apiKeys.gemini = process.env.GEMINI_API_KEY;
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

function validateConfig(config: AssistantConfig): void {
  if (!VALID_PROVIDERS.includes(config.provider as (typeof VALID_PROVIDERS)[number])) {
    log.warn(
      `Invalid provider "${config.provider}". Valid providers: ${VALID_PROVIDERS.join(', ')}. Falling back to "${DEFAULT_CONFIG.provider}".`,
    );
    config.provider = DEFAULT_CONFIG.provider;
  }

  if (!Number.isInteger(config.maxTokens) || config.maxTokens <= 0) {
    log.warn(
      `Invalid maxTokens "${config.maxTokens}". Must be a positive integer. Falling back to ${DEFAULT_CONFIG.maxTokens}.`,
    );
    config.maxTokens = DEFAULT_CONFIG.maxTokens;
  }

  if (typeof config.apiKeys !== 'object' || config.apiKeys === null || Array.isArray(config.apiKeys)) {
    log.warn('Invalid apiKeys: must be an object with string values. Falling back to empty object.');
    config.apiKeys = {};
  } else {
    for (const [key, value] of Object.entries(config.apiKeys)) {
      if (typeof value !== 'string') {
        log.warn(`Invalid apiKeys.${key}: value must be a string. Removing entry.`);
        delete config.apiKeys[key];
      }
    }
  }

  for (const field of ['shellDefaultTimeoutSec', 'shellMaxTimeoutSec', 'permissionTimeoutSec'] as const) {
    const val = config.timeouts[field];
    if (typeof val !== 'number' || !Number.isFinite(val) || val <= 0) {
      log.warn(
        `Invalid timeouts.${field} "${val}". Must be a positive number. Falling back to ${DEFAULT_CONFIG.timeouts[field]}.`,
      );
      config.timeouts[field] = DEFAULT_CONFIG.timeouts[field];
    }
  }
}

export function saveConfig(config: AssistantConfig): void {
  ensureDataDir();
  const configPath = getConfigPath();
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
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
 * Load the raw config from disk (without env var overrides).
 * Used by CLI config commands to read/write the file directly.
 */
export function loadRawConfig(): Record<string, unknown> {
  ensureDataDir();
  const configPath = getConfigPath();
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch (err) {
    throw new ConfigError(`Failed to parse config at ${configPath}: ${err}`);
  }
}

export function saveRawConfig(config: Record<string, unknown>): void {
  ensureDataDir();
  const configPath = getConfigPath();
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  cached = null; // invalidate cache
}

export function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const keys = path.split('.');
  let current: unknown = obj;
  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (current[key] === undefined || current[key] === null || typeof current[key] !== 'object') {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]] = value;
}

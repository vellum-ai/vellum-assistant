import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir, ensureDataDir } from '../util/platform.js';
import { ConfigError } from '../util/errors.js';
import { getLogger } from '../util/logger.js';
import { DEFAULT_CONFIG } from './defaults.js';
import { getSecureKey, setSecureKey, deleteSecureKey } from '../security/secure-keys.js';
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
  if (loading) return { ...DEFAULT_CONFIG, apiKeys: { ...DEFAULT_CONFIG.apiKeys }, timeouts: { ...DEFAULT_CONFIG.timeouts }, sandbox: { ...DEFAULT_CONFIG.sandbox }, rateLimit: { ...DEFAULT_CONFIG.rateLimit }, secretDetection: { ...DEFAULT_CONFIG.secretDetection }, auditLog: { ...DEFAULT_CONFIG.auditLog } };
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

    // Auto-migrate plaintext apiKeys from config.json to secure storage
    if (fileConfig.apiKeys && typeof fileConfig.apiKeys === 'object') {
      const plaintextKeys = Object.entries(fileConfig.apiKeys).filter(
        ([, v]) => typeof v === 'string' && v.length > 0,
      );
      if (plaintextKeys.length > 0) {
        const migratedProviders: string[] = [];
        for (const [provider, value] of plaintextKeys) {
          if (setSecureKey(provider, value as string)) {
            migratedProviders.push(provider);
          } else {
            log.warn(`Failed to migrate API key for "${provider}" to secure storage`);
          }
        }
        if (migratedProviders.length > 0) {
          // Rewrite config.json without successfully migrated apiKeys
          try {
            const rawJson = JSON.parse(readFileSync(configPath, 'utf-8'));
            for (const p of migratedProviders) {
              delete rawJson.apiKeys[p];
            }
            if (Object.keys(rawJson.apiKeys).length === 0) {
              delete rawJson.apiKeys;
            }
            writeFileSync(configPath, JSON.stringify(rawJson, null, 2) + '\n');
            log.info(`Migrated ${migratedProviders.length} API key(s) from config.json to secure storage`);
          } catch (err) {
            log.warn({ err }, 'Failed to remove migrated keys from config.json');
          }
        }
        // Clear only migrated keys from fileConfig so failed keys still flow into config
        for (const p of migratedProviders) {
          delete fileConfig.apiKeys![p];
        }
        if (Object.keys(fileConfig.apiKeys!).length === 0) {
          delete fileConfig.apiKeys;
        }
      }
    }

    const config: AssistantConfig = {
      ...DEFAULT_CONFIG,
      ...fileConfig,
      apiKeys: { ...DEFAULT_CONFIG.apiKeys, ...fileConfig.apiKeys },
      timeouts: { ...DEFAULT_CONFIG.timeouts, ...(fileConfig as Record<string, unknown>).timeouts as Partial<AssistantConfig['timeouts']> },
      sandbox: { ...DEFAULT_CONFIG.sandbox, ...(fileConfig as Record<string, unknown>).sandbox as Partial<AssistantConfig['sandbox']> },
      rateLimit: { ...DEFAULT_CONFIG.rateLimit, ...(fileConfig as Record<string, unknown>).rateLimit as Partial<AssistantConfig['rateLimit']> },
      secretDetection: { ...DEFAULT_CONFIG.secretDetection, ...(fileConfig as Record<string, unknown>).secretDetection as Partial<AssistantConfig['secretDetection']> },
      auditLog: { ...DEFAULT_CONFIG.auditLog, ...(fileConfig as Record<string, unknown>).auditLog as Partial<AssistantConfig['auditLog']> },
    };

    // Set cached before validation so re-entrant calls (e.g. validateConfig
    // logging triggers loadConfig) return the in-flight config instead of
    // bare defaults. Validation mutates the same object, so callers see
    // corrected values.
    cached = config;

    validateConfig(config);

    // Secure storage keys override plaintext config file
    try {
      for (const provider of ['anthropic', 'openai', 'gemini', 'ollama']) {
        const secureKey = getSecureKey(provider);
        if (secureKey) {
          config.apiKeys[provider] = secureKey;
        }
      }
    } catch (err) {
      log.debug({ err }, 'Failed to load keys from secure storage');
    }

    // Environment variables override everything (after validation so apiKeys is a valid object)
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

  if (typeof config.sandbox.enabled !== 'boolean') {
    log.warn(`Invalid sandbox.enabled "${config.sandbox.enabled}". Must be a boolean. Falling back to ${DEFAULT_CONFIG.sandbox.enabled}.`);
    config.sandbox.enabled = DEFAULT_CONFIG.sandbox.enabled;
  }

  for (const field of ['maxRequestsPerMinute', 'maxTokensPerSession'] as const) {
    const val = config.rateLimit[field];
    if (typeof val !== 'number' || !Number.isFinite(val) || val < 0 || !Number.isInteger(val)) {
      log.warn(
        `Invalid rateLimit.${field} "${val}". Must be a non-negative integer. Falling back to ${DEFAULT_CONFIG.rateLimit[field]}.`,
      );
      config.rateLimit[field] = DEFAULT_CONFIG.rateLimit[field];
    }
  }

  if (typeof config.secretDetection.enabled !== 'boolean') {
    log.warn(`Invalid secretDetection.enabled "${config.secretDetection.enabled}". Must be a boolean. Falling back to ${DEFAULT_CONFIG.secretDetection.enabled}.`);
    config.secretDetection.enabled = DEFAULT_CONFIG.secretDetection.enabled;
  }

  const validActions = ['redact', 'warn', 'block'] as const;
  if (!validActions.includes(config.secretDetection.action as (typeof validActions)[number])) {
    log.warn(`Invalid secretDetection.action "${config.secretDetection.action}". Must be one of: ${validActions.join(', ')}. Falling back to "${DEFAULT_CONFIG.secretDetection.action}".`);
    config.secretDetection.action = DEFAULT_CONFIG.secretDetection.action;
  }

  if (typeof config.secretDetection.entropyThreshold !== 'number' || !Number.isFinite(config.secretDetection.entropyThreshold) || config.secretDetection.entropyThreshold <= 0) {
    log.warn(`Invalid secretDetection.entropyThreshold "${config.secretDetection.entropyThreshold}". Must be a positive number. Falling back to ${DEFAULT_CONFIG.secretDetection.entropyThreshold}.`);
    config.secretDetection.entropyThreshold = DEFAULT_CONFIG.secretDetection.entropyThreshold;
  }

  if (typeof config.auditLog.retentionDays !== 'number' || !Number.isFinite(config.auditLog.retentionDays) || config.auditLog.retentionDays < 0 || !Number.isInteger(config.auditLog.retentionDays)) {
    log.warn(`Invalid auditLog.retentionDays "${config.auditLog.retentionDays}". Must be a non-negative integer. Falling back to ${DEFAULT_CONFIG.auditLog.retentionDays}.`);
    config.auditLog.retentionDays = DEFAULT_CONFIG.auditLog.retentionDays;
  }
}

export function saveConfig(config: AssistantConfig): void {
  ensureDataDir();
  const configPath = getConfigPath();

  // Route apiKeys to secure storage, write config without them
  for (const [provider, value] of Object.entries(config.apiKeys)) {
    if (typeof value === 'string' && value.length > 0) {
      setSecureKey(provider, value);
    }
  }
  // Delete secure keys for providers no longer in apiKeys or with empty values
  for (const provider of VALID_PROVIDERS) {
    const value = config.apiKeys[provider];
    if (!value || (typeof value === 'string' && value.length === 0)) {
      deleteSecureKey(provider);
    }
  }
  const { apiKeys: _, ...rest } = config;
  writeFileSync(configPath, JSON.stringify(rest, null, 2) + '\n');

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
 * Load the raw config from disk, merging API keys from secure storage.
 * Used by CLI config commands to read/write the file directly.
 */
export function loadRawConfig(): Record<string, unknown> {
  ensureDataDir();
  const configPath = getConfigPath();
  let raw: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch (err) {
      throw new ConfigError(`Failed to parse config at ${configPath}: ${err}`);
    }
  }

  // Merge secure keys into apiKeys so `config get apiKeys.*` works
  try {
    const apiKeys = (raw.apiKeys && typeof raw.apiKeys === 'object' && !Array.isArray(raw.apiKeys))
      ? { ...raw.apiKeys as Record<string, unknown> }
      : {};
    for (const provider of VALID_PROVIDERS) {
      const value = getSecureKey(provider);
      if (value) apiKeys[provider] = value;
    }
    if (Object.keys(apiKeys).length > 0) {
      raw.apiKeys = apiKeys;
    }
  } catch (err) {
    log.debug({ err }, 'Failed to merge secure keys into raw config');
  }

  return raw;
}

export function saveRawConfig(config: Record<string, unknown>): void {
  ensureDataDir();
  const configPath = getConfigPath();

  // Route apiKeys to secure storage and strip from plaintext file
  const apiKeys = config.apiKeys;
  if (apiKeys && typeof apiKeys === 'object' && !Array.isArray(apiKeys)) {
    for (const [provider, value] of Object.entries(apiKeys as Record<string, unknown>)) {
      if (typeof value === 'string' && value.length > 0) {
        if (!setSecureKey(provider, value)) {
          throw new ConfigError(`Failed to save API key for "${provider}" to secure storage. Key not removed from config to prevent data loss.`);
        }
      } else if (value === undefined || value === null || value === '') {
        deleteSecureKey(provider);
      }
    }
    // Remove apiKeys from plaintext config
    const { apiKeys: _, ...rest } = config;
    writeFileSync(configPath, JSON.stringify(rest, null, 2) + '\n');
  } else {
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  }

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

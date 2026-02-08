import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir, ensureDataDir } from '../util/platform.js';
import { ConfigError } from '../util/errors.js';
import { getLogger } from '../util/logger.js';
import { DEFAULT_CONFIG } from './defaults.js';

const log = getLogger('config');
import type { AssistantConfig } from './types.js';

let cached: AssistantConfig | null = null;

function getConfigPath(): string {
  return join(getDataDir(), 'config.json');
}

export function loadConfig(): AssistantConfig {
  if (cached) return cached;

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

  const config: AssistantConfig = {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    apiKeys: { ...DEFAULT_CONFIG.apiKeys, ...fileConfig.apiKeys },
  };

  // Environment variables override config file
  if (process.env.ANTHROPIC_API_KEY) {
    config.apiKeys.anthropic = process.env.ANTHROPIC_API_KEY;
  }
  if (process.env.OPENAI_API_KEY) {
    config.apiKeys.openai = process.env.OPENAI_API_KEY;
  }
  if (process.env.GEMINI_API_KEY) {
    config.apiKeys.gemini = process.env.GEMINI_API_KEY;
  }

  cached = config;
  return config;
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

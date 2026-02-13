import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { getHooksDir } from '../util/platform.js';
import { getLogger } from '../util/logger.js';
import type { HookConfig, HookConfigEntry, HookManifest } from './types.js';

const log = getLogger('hooks-config');

const HOOKS_CONFIG_VERSION = 1;

function getConfigPath(): string {
  return join(getHooksDir(), 'config.json');
}

export function loadHooksConfig(): HookConfig {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    return { version: HOOKS_CONFIG_VERSION, hooks: {} };
  }

  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as HookConfig;
    if (typeof parsed.version !== 'number' || typeof parsed.hooks !== 'object') {
      log.warn({ configPath }, 'Invalid hooks config, using defaults');
      return { version: HOOKS_CONFIG_VERSION, hooks: {} };
    }
    return parsed;
  } catch (err) {
    log.warn({ err, configPath }, 'Failed to read hooks config, using defaults');
    return { version: HOOKS_CONFIG_VERSION, hooks: {} };
  }
}

export function saveHooksConfig(config: HookConfig): void {
  const configPath = getConfigPath();
  const dir = dirname(configPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

export function isHookEnabled(hookName: string): boolean {
  const config = loadHooksConfig();
  return config.hooks[hookName]?.enabled ?? false;
}

export function setHookEnabled(hookName: string, enabled: boolean): void {
  const config = loadHooksConfig();
  config.hooks[hookName] = { ...config.hooks[hookName], enabled };
  saveHooksConfig(config);
}

export function ensureHookInConfig(hookName: string, entry: HookConfigEntry): void {
  const config = loadHooksConfig();
  if (hookName in config.hooks) return;
  config.hooks[hookName] = entry;
  saveHooksConfig(config);
}

/**
 * Get merged settings for a hook. Manifest defaults are used as the base,
 * then user overrides from config.json are applied on top.
 */
export function getHookSettings(hookName: string, manifest: HookManifest): Record<string, unknown> {
  // Start with defaults from manifest schema
  const defaults: Record<string, unknown> = {};
  if (manifest.settingsSchema) {
    for (const [key, schema] of Object.entries(manifest.settingsSchema)) {
      if (schema.default !== undefined) {
        defaults[key] = schema.default;
      }
    }
  }

  // Merge user overrides from config
  const config = loadHooksConfig();
  const userSettings = config.hooks[hookName]?.settings ?? {};

  return { ...defaults, ...userSettings };
}

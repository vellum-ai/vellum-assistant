import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { ensureDir, readTextFileSync } from "../util/fs.js";
import { getLogger } from "../util/logger.js";
import { getWorkspaceHooksDir } from "../util/platform.js";
import type { HookConfig, HookConfigEntry, HookManifest } from "./types.js";

const log = getLogger("hooks-config");

const HOOKS_CONFIG_VERSION = 1;

function getConfigPath(): string {
  return join(getWorkspaceHooksDir(), "config.json");
}

export function loadHooksConfig(): HookConfig {
  const configPath = getConfigPath();
  const raw = readTextFileSync(configPath);
  if (raw == null) {
    return { version: HOOKS_CONFIG_VERSION, hooks: {} };
  }

  try {
    const parsed = JSON.parse(raw) as HookConfig;
    if (
      typeof parsed.version !== "number" ||
      typeof parsed.hooks !== "object" ||
      parsed.hooks == null
    ) {
      log.warn({ configPath }, "Invalid hooks config, using defaults");
      return { version: HOOKS_CONFIG_VERSION, hooks: {} };
    }
    return parsed;
  } catch (err) {
    log.warn(
      { err, configPath },
      "Failed to read hooks config, using defaults",
    );
    return { version: HOOKS_CONFIG_VERSION, hooks: {} };
  }
}

export function saveHooksConfig(config: HookConfig): void {
  const configPath = getConfigPath();
  ensureDir(dirname(configPath));
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
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

export function ensureHookInConfig(
  hookName: string,
  entry: HookConfigEntry,
): void {
  const config = loadHooksConfig();
  if (hookName in config.hooks) return;
  config.hooks[hookName] = entry;
  saveHooksConfig(config);
}

export function removeHook(hookName: string): void {
  const config = loadHooksConfig();
  delete config.hooks[hookName];
  saveHooksConfig(config);
}

/**
 * Get merged settings for a hook. Manifest defaults are used as the base,
 * then user overrides from config.json are applied on top.
 */
export function getHookSettings(
  hookName: string,
  manifest: HookManifest,
): Record<string, unknown> {
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

/**
 * Autonomy config persistence — reads/writes autonomy policy from a
 * dedicated JSON file in the workspace directory.
 *
 * The autonomy config lives at ~/.vellum/workspace/autonomy.json, separate
 * from the main config.json. This is policy configuration (not learned
 * preferences), so it belongs on disk rather than in the SQLite database.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getWorkspaceDir } from '../util/platform.js';
import { getLogger } from '../util/logger.js';
import type { AutonomyConfig, AutonomyTier } from './types.js';
import { DEFAULT_AUTONOMY_CONFIG, AUTONOMY_TIERS } from './types.js';

const log = getLogger('autonomy-store');

function getAutonomyConfigPath(): string {
  return join(getWorkspaceDir(), 'autonomy.json');
}

/**
 * Load the current autonomy configuration from disk.
 * Returns defaults if the file doesn't exist or is malformed.
 */
export function getAutonomyConfig(): AutonomyConfig {
  const configPath = getAutonomyConfigPath();
  if (!existsSync(configPath)) {
    return { ...DEFAULT_AUTONOMY_CONFIG };
  }

  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    return validateAutonomyConfig(raw);
  } catch (err) {
    log.warn({ err }, 'Failed to parse autonomy config; using defaults');
    return { ...DEFAULT_AUTONOMY_CONFIG };
  }
}

/**
 * Merge partial updates into the existing autonomy configuration and persist.
 * Only the provided fields are updated; omitted fields keep their current values.
 */
export function setAutonomyConfig(updates: Partial<AutonomyConfig>): AutonomyConfig {
  const current = getAutonomyConfig();

  if (updates.defaultTier !== undefined) {
    current.defaultTier = updates.defaultTier;
  }
  if (updates.channelDefaults !== undefined) {
    current.channelDefaults = { ...current.channelDefaults, ...updates.channelDefaults };
  }
  if (updates.categoryOverrides !== undefined) {
    current.categoryOverrides = { ...current.categoryOverrides, ...updates.categoryOverrides };
  }
  if (updates.contactOverrides !== undefined) {
    current.contactOverrides = { ...current.contactOverrides, ...updates.contactOverrides };
  }

  persistConfig(current);
  return current;
}

/**
 * Get the autonomy tier configured for a specific channel.
 * Returns undefined if no channel-specific default is set.
 */
export function getChannelDefault(channel: string): AutonomyTier | undefined {
  const config = getAutonomyConfig();
  return config.channelDefaults[channel];
}

/**
 * Set the autonomy tier for a specific channel.
 */
export function setChannelDefault(channel: string, tier: AutonomyTier): void {
  const config = getAutonomyConfig();
  config.channelDefaults[channel] = tier;
  persistConfig(config);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function persistConfig(config: AutonomyConfig): void {
  const configPath = getAutonomyConfigPath();
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
}

function isValidTier(value: unknown): value is AutonomyTier {
  return typeof value === 'string' && AUTONOMY_TIERS.includes(value as AutonomyTier);
}

function validateTierRecord(raw: unknown): Record<string, AutonomyTier> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const result: Record<string, AutonomyTier> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isValidTier(value)) {
      result[key] = value;
    }
  }
  return result;
}

function validateAutonomyConfig(raw: unknown): AutonomyConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_AUTONOMY_CONFIG };
  }

  const obj = raw as Record<string, unknown>;

  return {
    defaultTier: isValidTier(obj.defaultTier) ? obj.defaultTier : DEFAULT_AUTONOMY_CONFIG.defaultTier,
    channelDefaults: validateTierRecord(obj.channelDefaults),
    categoryOverrides: validateTierRecord(obj.categoryOverrides),
    contactOverrides: validateTierRecord(obj.contactOverrides),
  };
}

/**
 * Parental control settings and PIN management.
 *
 * Non-secret settings (enabled state, content restrictions, blocked tool
 * categories) are persisted to `~/.vellum/parental-control.json`.
 *
 * The PIN hash and salt are stored in the encrypted key store under the
 * account `parental:pin` as the hex string `"<salt>:<hash>"`.
 *
 * PIN hashing uses SHA-256 with a random 16-byte salt to prevent offline
 * dictionary attacks. Comparison uses timingSafeEqual to avoid timing leaks.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathExists, ensureDir } from '../util/fs.js';
import { getRootDir } from '../util/platform.js';
import { getKey, setKey, deleteKey } from './encrypted-store.js';
import { getLogger } from '../util/logger.js';
import type { ParentalContentTopic, ParentalToolCategory } from '../daemon/ipc-contract/parental-control.js';

const log = getLogger('parental-control');

const PIN_ACCOUNT = 'parental:pin';

export type { ParentalContentTopic, ParentalToolCategory };

export interface ParentalControlSettings {
  enabled: boolean;
  contentRestrictions: ParentalContentTopic[];
  blockedToolCategories: ParentalToolCategory[];
}

const DEFAULT_SETTINGS: ParentalControlSettings = {
  enabled: false,
  contentRestrictions: [],
  blockedToolCategories: [],
};

function getSettingsPath(): string {
  return join(getRootDir(), 'parental-control.json');
}

// ---------------------------------------------------------------------------
// Settings I/O
// ---------------------------------------------------------------------------

export function getParentalControlSettings(): ParentalControlSettings {
  try {
    const file = getSettingsPath();
    if (!pathExists(file)) return { ...DEFAULT_SETTINGS };
    const raw = readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<ParentalControlSettings>;
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : false,
      contentRestrictions: Array.isArray(parsed.contentRestrictions) ? parsed.contentRestrictions : [],
      blockedToolCategories: Array.isArray(parsed.blockedToolCategories) ? parsed.blockedToolCategories : [],
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings: ParentalControlSettings): void {
  const file = getSettingsPath();
  ensureDir(dirname(file));
  writeFileSync(file, JSON.stringify(settings, null, 2), { encoding: 'utf-8' });
}

export function updateParentalControlSettings(
  patch: Partial<ParentalControlSettings>,
): ParentalControlSettings {
  const current = getParentalControlSettings();
  const next: ParentalControlSettings = {
    enabled: patch.enabled !== undefined ? patch.enabled : current.enabled,
    contentRestrictions: patch.contentRestrictions !== undefined
      ? patch.contentRestrictions
      : current.contentRestrictions,
    blockedToolCategories: patch.blockedToolCategories !== undefined
      ? patch.blockedToolCategories
      : current.blockedToolCategories,
  };
  saveSettings(next);
  return next;
}

// ---------------------------------------------------------------------------
// PIN management
// ---------------------------------------------------------------------------

/** Returns true if a parental control PIN has been configured. */
export function hasPIN(): boolean {
  return getKey(PIN_ACCOUNT) !== undefined;
}

function hashPIN(pin: string, salt: Buffer): Buffer {
  return createHash('sha256').update(salt).update(pin).digest();
}

/**
 * Set a new PIN. Rejects if `pin` is not exactly 6 ASCII digits.
 * Throws if the store write fails.
 */
export function setPIN(pin: string): void {
  if (!/^\d{6}$/.test(pin)) {
    throw new Error('PIN must be exactly 6 digits');
  }
  const salt = randomBytes(16);
  const hash = hashPIN(pin, salt);
  const stored = `${salt.toString('hex')}:${hash.toString('hex')}`;
  if (!setKey(PIN_ACCOUNT, stored)) {
    throw new Error('Failed to persist PIN — encrypted store write error');
  }
  log.info('Parental control PIN set');
}

/**
 * Verify a PIN attempt. Returns true on match, false on mismatch or if no
 * PIN has been configured. Uses constant-time comparison to prevent timing
 * attacks.
 */
export function verifyPIN(pin: string): boolean {
  if (!/^\d{6}$/.test(pin)) return false;
  const stored = getKey(PIN_ACCOUNT);
  if (!stored) return false;

  const colonIdx = stored.indexOf(':');
  if (colonIdx === -1) return false;

  try {
    const salt = Buffer.from(stored.slice(0, colonIdx), 'hex');
    const expectedHash = Buffer.from(stored.slice(colonIdx + 1), 'hex');
    const actualHash = hashPIN(pin, salt);
    if (actualHash.length !== expectedHash.length) return false;
    return timingSafeEqual(actualHash, expectedHash);
  } catch {
    return false;
  }
}

/**
 * Remove the PIN. The caller is responsible for requiring PIN verification
 * before calling this.
 */
export function clearPIN(): void {
  deleteKey(PIN_ACCOUNT);
  log.info('Parental control PIN cleared');
}

// ---------------------------------------------------------------------------
// Tool category → tool name mapping
// ---------------------------------------------------------------------------

/**
 * Tool name prefixes that belong to each blocked category.
 * A tool is considered blocked if its name starts with any of the listed
 * prefixes (case-sensitive).
 */
export const TOOL_CATEGORY_PREFIXES: Record<ParentalToolCategory, string[]> = {
  computer_use: ['cu_', 'computer_use', 'screenshot', 'accessibility_'],
  network: ['web_fetch', 'web_search', 'browser_'],
  shell: ['bash', 'terminal', 'host_shell'],
  file_write: ['file_write', 'file_edit', 'multi_edit', 'file_delete', 'git'],
};

/**
 * Returns true if the given tool name falls within any of the currently
 * blocked tool categories.
 */
export function isToolBlocked(toolName: string): boolean {
  const { enabled, blockedToolCategories } = getParentalControlSettings();
  if (!enabled || blockedToolCategories.length === 0) return false;

  for (const category of blockedToolCategories) {
    const prefixes = TOOL_CATEGORY_PREFIXES[category];
    if (prefixes.some((p) => toolName.startsWith(p))) return true;
  }
  return false;
}

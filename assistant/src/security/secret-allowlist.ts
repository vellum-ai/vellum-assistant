/**
 * User-defined allowlist for suppressing secret scanner false positives.
 *
 * Reads `~/.vellum/secret-allowlist.json` (if present) and provides
 * `isAllowlisted(value)` to check whether a matched value should be
 * suppressed.
 *
 * File format:
 * {
 *   "values": ["exact-value-to-skip", ...],
 *   "prefixes": ["sk-test-", ...],
 *   "patterns": ["^test_.*$", ...]
 * }
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '../util/platform.js';
import { getLogger } from '../util/logger.js';

const log = getLogger('secret-allowlist');

export interface AllowlistConfig {
  /** Exact values to suppress (case-sensitive). */
  values?: string[];
  /** Prefix strings — any matched value starting with one of these is suppressed. */
  prefixes?: string[];
  /** Regex patterns (strings) — any matched value matching one of these is suppressed. */
  patterns?: string[];
}

// Cached state
let loaded = false;
let allowedValues: Set<string> = new Set();
let allowedPrefixes: string[] = [];
let allowedRegexes: RegExp[] = [];

/**
 * Load the allowlist from disk. Called lazily on first `isAllowlisted` call.
 * Safe to call multiple times — subsequent calls are no-ops unless `resetAllowlist` is called.
 */
export function loadAllowlist(): void {
  if (loaded) return;

  const filePath = join(getDataDir(), 'secret-allowlist.json');
  if (!existsSync(filePath)) return;

  try {
    const raw = readFileSync(filePath, 'utf-8');
    const config: AllowlistConfig = JSON.parse(raw);

    if (config.values && Array.isArray(config.values)) {
      allowedValues = new Set(config.values.filter((v) => typeof v === 'string'));
    }

    if (config.prefixes && Array.isArray(config.prefixes)) {
      allowedPrefixes = config.prefixes.filter((p) => typeof p === 'string' && p.length > 0);
    }

    if (config.patterns && Array.isArray(config.patterns)) {
      for (const p of config.patterns) {
        if (typeof p !== 'string') continue;
        try {
          allowedRegexes.push(new RegExp(p));
        } catch {
          log.warn({ pattern: p }, 'Invalid regex in secret-allowlist.json, skipping');
        }
      }
    }

    // Only mark as loaded after successful parse
    loaded = true;

    const total = allowedValues.size + allowedPrefixes.length + allowedRegexes.length;
    if (total > 0) {
      log.debug({ values: allowedValues.size, prefixes: allowedPrefixes.length, patterns: allowedRegexes.length }, 'Loaded secret allowlist');
    }
  } catch (err) {
    log.warn({ err }, 'Failed to load secret-allowlist.json');
  }
}

/**
 * Check if a matched secret value is on the user's allowlist.
 */
export function isAllowlisted(value: string): boolean {
  loadAllowlist();

  if (allowedValues.has(value)) return true;

  for (const prefix of allowedPrefixes) {
    if (value.startsWith(prefix)) return true;
  }

  for (const re of allowedRegexes) {
    re.lastIndex = 0;
    if (re.test(value)) return true;
  }

  return false;
}

/**
 * Reset cached state. Used in tests.
 */
export function resetAllowlist(): void {
  loaded = false;
  allowedValues = new Set();
  allowedPrefixes = [];
  allowedRegexes = [];
}

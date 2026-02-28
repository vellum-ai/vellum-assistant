/**
 * Minimal config loader used by the Twitter strategy router.
 * Inlined from assistant/src/config/loader.ts (stripped of migrations and secure-key merging).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getDataDir } from './platform.js';

export function loadRawConfig(): Record<string, unknown> {
  const configPath = join(getDataDir(), '..', 'config.json');
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    return {};
  }
}

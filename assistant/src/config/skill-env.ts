import type { SkillSummary } from './skills.js';
import { getLogger } from '../util/logger.js';

const log = getLogger('skill-env');

export interface EnvSnapshot {
  original: Map<string, string | undefined>;
}

/**
 * Apply environment overrides from skill config entries.
 * Only sets variables that aren't already set in process.env.
 * Returns a snapshot for later restoration.
 */
export function applySkillEnv(
  skills: SkillSummary[],
  entries: Record<string, { apiKey?: string; env?: Record<string, string> }>,
): EnvSnapshot {
  const original = new Map<string, string | undefined>();

  for (const skill of skills) {
    const configKey = skill.id;
    const entry = entries[configKey];
    if (!entry) continue;

    // Map apiKey to primaryEnv
    if (entry.apiKey && skill.metadata?.primaryEnv) {
      const key = skill.metadata.primaryEnv;
      if (!(key in process.env)) {
        original.set(key, process.env[key]);
        process.env[key] = entry.apiKey;
        log.debug({ key, skill: skill.id }, 'Injected apiKey as env var');
      }
    }

    // Apply explicit env overrides
    if (entry.env) {
      for (const [key, value] of Object.entries(entry.env)) {
        if (!(key in process.env)) {
          original.set(key, process.env[key]);
          process.env[key] = value;
          log.debug({ key, skill: skill.id }, 'Injected skill env var');
        }
      }
    }
  }

  return { original };
}

/**
 * Restore the original environment after an agent run.
 */
export function restoreSkillEnv(snapshot: EnvSnapshot): void {
  for (const [key, originalValue] of snapshot.original) {
    if (originalValue === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalValue;
    }
  }
  log.debug({ count: snapshot.original.size }, 'Restored original env');
}

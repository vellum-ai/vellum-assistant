import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CatalogEntry } from '../tools/skills/vellum-catalog.js';
import { getLogger } from '../util/logger.js';

const log = getLogger('vellum-catalog-remote');

const PLATFORM_URL = process.env.VELLUM_ASSISTANT_PLATFORM_URL ?? 'https://assistant.vellum.ai';

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

interface CatalogManifest {
  version: number;
  skills: CatalogEntry[];
}

let cachedEntries: CatalogEntry[] | null = null;
let cacheTimestamp = 0;

function getBundledCatalogPath(): string {
  return join(import.meta.dir, '..', 'config', 'vellum-skills', 'catalog.json');
}

function loadBundledCatalog(): CatalogEntry[] {
  try {
    const raw = readFileSync(getBundledCatalogPath(), 'utf-8');
    const manifest: CatalogManifest = JSON.parse(raw);
    return manifest.skills ?? [];
  } catch (err) {
    log.warn({ err }, 'Failed to read bundled catalog.json');
    return [];
  }
}

function getBundledSkillContent(skillId: string): string | null {
  try {
    const skillPath = join(import.meta.dir, '..', 'config', 'vellum-skills', skillId, 'SKILL.md');
    return readFileSync(skillPath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Fetch catalog entries from the platform API. Falls back to bundled copy.
 * @param sessionToken Optional X-Session-Token for authenticated platform requests.
 */
export async function fetchCatalogEntries(sessionToken?: string): Promise<CatalogEntry[]> {
  const now = Date.now();
  if (cachedEntries && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedEntries;
  }

  try {
    const url = `${PLATFORM_URL}/v1/skills/`;
    const headers: Record<string, string> = {};
    if (sessionToken) {
      headers['X-Session-Token'] = sessionToken;
    }

    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const manifest: CatalogManifest = await response.json();
    const skills = manifest.skills;
    if (!Array.isArray(skills) || skills.length === 0) {
      throw new Error('Platform catalog has invalid or empty skills array');
    }
    cachedEntries = skills;
    cacheTimestamp = now;
    log.info({ count: cachedEntries.length }, 'Fetched vellum-skills catalog from platform API');
    return cachedEntries;
  } catch (err) {
    log.warn({ err }, 'Failed to fetch catalog from platform API, falling back to bundled copy');
    const bundled = loadBundledCatalog();
    // Cache the bundled result too so we don't re-fetch on every call during outage
    cachedEntries = bundled;
    cacheTimestamp = now;
    return bundled;
  }
}

/** Fetch a skill's SKILL.md content. Falls back to bundled copy. */
export async function fetchSkillContent(skillId: string): Promise<string | null> {
  // SKILL.md content is bundled — no platform API for individual skill content yet
  return getBundledSkillContent(skillId);
}

/** Check if a skill ID exists in the catalog. */
export async function checkVellumSkill(skillId: string): Promise<boolean> {
  const entries = await fetchCatalogEntries();
  return entries.some((e) => e.id === skillId);
}

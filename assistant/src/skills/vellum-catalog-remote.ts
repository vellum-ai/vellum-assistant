import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CatalogEntry } from '../tools/skills/vellum-catalog.js';
import { getLogger } from '../util/logger.js';

const log = getLogger('vellum-catalog-remote');

const GITHUB_RAW_BASE =
  'https://raw.githubusercontent.com/vellum-ai/vellum-assistant/main/assistant/src/config/vellum-skills';

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

/** Fetch catalog entries (cached, async). Falls back to bundled copy. */
export async function fetchCatalogEntries(): Promise<CatalogEntry[]> {
  const now = Date.now();
  if (cachedEntries && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedEntries;
  }

  try {
    const url = `${GITHUB_RAW_BASE}/catalog.json`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const manifest: CatalogManifest = await response.json();
    const skills = manifest.skills;
    if (!Array.isArray(skills) || skills.length === 0) {
      throw new Error('Remote catalog has invalid or empty skills array');
    }
    cachedEntries = skills;
    cacheTimestamp = now;
    log.info({ count: cachedEntries.length }, 'Fetched remote vellum-skills catalog');
    return cachedEntries;
  } catch (err) {
    log.warn({ err }, 'Failed to fetch remote catalog, falling back to bundled copy');
    const bundled = loadBundledCatalog();
    // Cache the bundled result too so we don't re-fetch on every call during outage
    cachedEntries = bundled;
    cacheTimestamp = now;
    return bundled;
  }
}

/** Fetch a skill's SKILL.md content from GitHub. Falls back to bundled copy. */
export async function fetchSkillContent(skillId: string): Promise<string | null> {
  try {
    const url = `${GITHUB_RAW_BASE}/${encodeURIComponent(skillId)}/SKILL.md`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const content = await response.text();
    log.info({ skillId }, 'Fetched remote SKILL.md');
    return content;
  } catch (err) {
    log.warn({ err, skillId }, 'Failed to fetch remote SKILL.md, falling back to bundled copy');
    return getBundledSkillContent(skillId);
  }
}

/** Check if a skill ID exists in the remote catalog. */
export async function checkVellumSkill(skillId: string): Promise<boolean> {
  const entries = await fetchCatalogEntries();
  return entries.some((e) => e.id === skillId);
}

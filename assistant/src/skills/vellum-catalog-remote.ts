import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import type { CatalogEntry } from '../tools/skills/vellum-catalog.js';
import { getLogger } from '../util/logger.js';
import { readPlatformToken } from '../util/platform.js';

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

/** Build request headers, including platform token when available. */
function buildPlatformHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const token = readPlatformToken();
  if (token) {
    headers['X-Session-Token'] = token;
  }
  return headers;
}

/**
 * Fetch catalog entries from the platform API. Falls back to bundled copy.
 * Reads the platform token from ~/.vellum/platform-token automatically.
 */
export async function fetchCatalogEntries(): Promise<CatalogEntry[]> {
  const now = Date.now();
  if (cachedEntries && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedEntries;
  }

  try {
    const url = `${PLATFORM_URL}/v1/skills/`;
    const response = await fetch(url, {
      headers: buildPlatformHeaders(),
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

/**
 * Extract SKILL.md content from a tar archive (uncompressed).
 * Tar format: 512-byte header blocks followed by file data blocks.
 */
function extractSkillMdFromTar(tarBuffer: Buffer): string | null {
  let offset = 0;
  while (offset + 512 <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + 512);

    // Check for end-of-archive (two consecutive zero blocks)
    if (header.every((b) => b === 0)) break;

    // Extract filename (bytes 0-99, null-terminated)
    const nameEnd = header.indexOf(0, 0);
    const name = header.subarray(0, Math.min(nameEnd >= 0 ? nameEnd : 100, 100)).toString('utf-8');

    // Extract file size (bytes 124-135, octal string)
    const sizeStr = header.subarray(124, 136).toString('utf-8').trim();
    const size = parseInt(sizeStr, 8) || 0;

    offset += 512; // move past header

    if (name.endsWith('SKILL.md') || name === 'SKILL.md') {
      return tarBuffer.subarray(offset, offset + size).toString('utf-8');
    }

    // Skip to next header (data blocks are padded to 512 bytes)
    offset += Math.ceil(size / 512) * 512;
  }
  return null;
}

/**
 * Fetch a skill's SKILL.md content from the platform tar API.
 * GET /v1/skills/{skill_id}/ returns a tar.gz archive containing all skill files.
 * Falls back to bundled copy on failure.
 */
export async function fetchSkillContent(skillId: string): Promise<string | null> {
  try {
    const url = `${PLATFORM_URL}/v1/skills/${encodeURIComponent(skillId)}/`;
    const response = await fetch(url, {
      headers: buildPlatformHeaders(),
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const gzipBuffer = Buffer.from(await response.arrayBuffer());
    const tarBuffer = gunzipSync(gzipBuffer);
    const skillMd = extractSkillMdFromTar(tarBuffer);

    if (skillMd) {
      return skillMd;
    }

    log.warn({ skillId }, 'SKILL.md not found in platform tar archive, falling back to bundled');
  } catch (err) {
    log.warn({ err, skillId }, 'Failed to fetch skill content from platform API, falling back to bundled');
  }

  return getBundledSkillContent(skillId);
}

/** Check if a skill ID exists in the catalog. */
export async function checkVellumSkill(skillId: string): Promise<boolean> {
  const entries = await fetchCatalogEntries();
  return entries.some((e) => e.id === skillId);
}

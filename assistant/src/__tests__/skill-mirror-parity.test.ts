/**
 * Drift guard: asserts parity between mirrored first-party skill directories.
 *
 * Skills that exist in both `assistant/src/config/vellum-skills/` (embedded in
 * the runtime) and `skills/` (top-level repo, fetched from GitHub at runtime)
 * must have identical SKILL.md content. The catalog.json entries for shared
 * skills must also match.
 *
 * This test prevents silent drift between the two copies. When a skill is
 * updated in one location but not the other, this test fails with a clear
 * message indicating which skill and file diverged.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, test } from 'bun:test';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const ASSISTANT_DIR = resolve(__dirname, '..', '..');
const REPO_ROOT = resolve(ASSISTANT_DIR, '..');

const EMBEDDED_SKILLS_DIR = join(ASSISTANT_DIR, 'src', 'config', 'vellum-skills');
const TOPLEVEL_SKILLS_DIR = join(REPO_ROOT, 'skills');

const EMBEDDED_CATALOG = join(EMBEDDED_SKILLS_DIR, 'catalog.json');
const TOPLEVEL_CATALOG = join(TOPLEVEL_SKILLS_DIR, 'catalog.json');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  emoji: string;
  includes?: string[];
}

interface Catalog {
  description: string;
  version: number;
  skills: CatalogEntry[];
}

/** List subdirectories (skill directories) in a given parent. */
function listSkillDirs(parent: string): string[] {
  if (!existsSync(parent)) return [];
  return readdirSync(parent).filter((entry) => {
    const full = join(parent, entry);
    return statSync(full).isDirectory();
  });
}

/** Find skill IDs that exist as directories in both locations. */
function findSharedSkills(): string[] {
  const embedded = new Set(listSkillDirs(EMBEDDED_SKILLS_DIR));
  const toplevel = new Set(listSkillDirs(TOPLEVEL_SKILLS_DIR));
  return [...embedded].filter((id) => toplevel.has(id)).sort();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Skill mirror parity — embedded ↔ top-level', () => {
  const sharedSkills = findSharedSkills();

  test('at least one shared skill exists (sanity check)', () => {
    expect(sharedSkills.length).toBeGreaterThan(0);
  });

  // ── Every top-level skill must have an embedded source ──────────────────

  test('every top-level skill directory has a corresponding embedded directory', () => {
    const embedded = new Set(listSkillDirs(EMBEDDED_SKILLS_DIR));
    const toplevel = listSkillDirs(TOPLEVEL_SKILLS_DIR);

    const missingFromEmbedded = toplevel.filter((id) => !embedded.has(id));

    expect(missingFromEmbedded).toEqual([]);
  });

  // ── SKILL.md content parity ─────────────────────────────────────────────

  for (const skillId of sharedSkills) {
    test(`${skillId}/SKILL.md content matches between embedded and top-level`, () => {
      const embeddedPath = join(EMBEDDED_SKILLS_DIR, skillId, 'SKILL.md');
      const toplevelPath = join(TOPLEVEL_SKILLS_DIR, skillId, 'SKILL.md');

      const embeddedExists = existsSync(embeddedPath);
      const toplevelExists = existsSync(toplevelPath);

      if (!embeddedExists && !toplevelExists) {
        // Neither has a SKILL.md — acceptable, no parity violation
        return;
      }

      // If one exists but not the other, that is a drift violation
      expect(embeddedExists).toBe(
        toplevelExists,
      );

      if (!embeddedExists || !toplevelExists) return;

      const embeddedContent = readFileSync(embeddedPath, 'utf-8');
      const toplevelContent = readFileSync(toplevelPath, 'utf-8');

      expect(embeddedContent).toBe(toplevelContent);
    });
  }

  // ── Every top-level catalog entry must have an embedded source ──────────

  test('every top-level catalog entry exists in the embedded catalog', () => {
    expect(existsSync(EMBEDDED_CATALOG)).toBe(true);
    expect(existsSync(TOPLEVEL_CATALOG)).toBe(true);

    const embeddedCatalog: Catalog = JSON.parse(readFileSync(EMBEDDED_CATALOG, 'utf-8'));
    const toplevelCatalog: Catalog = JSON.parse(readFileSync(TOPLEVEL_CATALOG, 'utf-8'));

    const embeddedIds = new Set(embeddedCatalog.skills.map((s) => s.id));
    const toplevelIds = toplevelCatalog.skills.map((s) => s.id);

    const missingFromEmbedded = toplevelIds.filter((id) => !embeddedIds.has(id));

    expect(missingFromEmbedded).toEqual([]);
  });

  // ── Catalog entry parity for shared skills ──────────────────────────────

  test('catalog.json entries match for all shared skills', () => {
    expect(existsSync(EMBEDDED_CATALOG)).toBe(true);
    expect(existsSync(TOPLEVEL_CATALOG)).toBe(true);

    const embeddedCatalog: Catalog = JSON.parse(readFileSync(EMBEDDED_CATALOG, 'utf-8'));
    const toplevelCatalog: Catalog = JSON.parse(readFileSync(TOPLEVEL_CATALOG, 'utf-8'));

    const embeddedMap = new Map(embeddedCatalog.skills.map((s) => [s.id, s]));
    const toplevelMap = new Map(toplevelCatalog.skills.map((s) => [s.id, s]));

    // Only compare entries that exist in both catalogs
    const sharedIds = [...embeddedMap.keys()].filter((id) => toplevelMap.has(id));

    expect(sharedIds.length).toBeGreaterThan(0);

    for (const id of sharedIds) {
      const embedded = embeddedMap.get(id)!;
      const toplevel = toplevelMap.get(id)!;

      expect(embedded).toEqual(toplevel);
    }
  });
});

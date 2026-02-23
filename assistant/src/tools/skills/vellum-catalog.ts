import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

import { RiskLevel } from '../../permissions/types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { createManagedSkill } from '../../skills/managed-store.js';
import { getLogger } from '../../util/logger.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';

const log = getLogger('vellum-skills-catalog');

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

function getVellumSkillsDir(): string {
  return join(import.meta.dir, '..', '..', 'config', 'vellum-skills');
}

export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  emoji?: string;
  includes?: string[];
}

function parseCatalogEntry(directory: string): CatalogEntry | null {
  const skillFilePath = join(directory, 'SKILL.md');
  if (!existsSync(skillFilePath)) return null;

  try {
    const stat = statSync(skillFilePath);
    if (!stat.isFile()) return null;

    const content = readFileSync(skillFilePath, 'utf-8');
    const match = content.match(FRONTMATTER_REGEX);
    if (!match) return null;

    const fields: Record<string, string> = {};
    for (const line of match[1].split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const separatorIndex = trimmed.indexOf(':');
      if (separatorIndex === -1) continue;

      const key = trimmed.slice(0, separatorIndex).trim();
      let value = trimmed.slice(separatorIndex + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      fields[key] = value;
    }

    const name = fields.name?.trim();
    const description = fields.description?.trim();
    if (!name || !description) return null;

    let emoji: string | undefined;
    const metadataRaw = fields.metadata?.trim();
    if (metadataRaw) {
      try {
        const parsed = JSON.parse(metadataRaw);
        if (parsed?.vellum?.emoji) {
          emoji = parsed.vellum.emoji as string;
        }
      } catch {
        // ignore malformed metadata
      }
    }

    let includes: string[] | undefined;
    const includesRaw = fields.includes?.trim();
    if (includesRaw) {
      try {
        const parsed = JSON.parse(includesRaw);
        if (Array.isArray(parsed) && parsed.every((item: unknown) => typeof item === 'string')) {
          const filtered = (parsed as string[]).map((s) => s.trim()).filter((s) => s.length > 0);
          if (filtered.length > 0) includes = filtered;
        }
      } catch {
        // ignore malformed includes
      }
    }

    return { id: basename(directory), name, description, emoji, includes };
  } catch (err) {
    log.warn({ err, directory }, 'Failed to read catalog entry');
    return null;
  }
}

export function listCatalogEntries(): CatalogEntry[] {
  const catalogDir = getVellumSkillsDir();
  if (!existsSync(catalogDir)) return [];

  const entries: CatalogEntry[] = [];
  try {
    const dirEntries = readdirSync(catalogDir, { withFileTypes: true });
    for (const entry of dirEntries) {
      if (!entry.isDirectory()) continue;
      const parsed = parseCatalogEntry(join(catalogDir, entry.name));
      if (parsed) entries.push(parsed);
    }
  } catch (err) {
    log.warn({ err, catalogDir }, 'Failed to list catalog entries');
  }

  return entries.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Install a skill from the vellum-skills catalog by ID.
 * Returns { success, skillName, error }.
 */
export function installFromVellumCatalog(skillId: string): { success: boolean; skillName?: string; error?: string } {
  const catalogDir = getVellumSkillsDir();
  const skillDir = join(catalogDir, skillId.trim());
  const skillFilePath = join(skillDir, 'SKILL.md');

  if (!existsSync(skillFilePath)) {
    return { success: false, error: `Skill "${skillId}" not found in the Vellum catalog` };
  }

  const content = readFileSync(skillFilePath, 'utf-8');
  const match = content.match(FRONTMATTER_REGEX);
  if (!match) {
    return { success: false, error: `Skill "${skillId}" has invalid SKILL.md` };
  }

  const entry = parseCatalogEntry(skillDir);
  if (!entry) {
    return { success: false, error: `Skill "${skillId}" has invalid SKILL.md` };
  }

  const bodyMarkdown = content.slice(match[0].length);
  const result = createManagedSkill({
    id: entry.id,
    name: entry.name,
    description: entry.description,
    bodyMarkdown,
    emoji: entry.emoji,
    includes: entry.includes,
    overwrite: true,
    addToIndex: true,
  });

  if (!result.created) {
    return { success: false, error: result.error };
  }

  return { success: true, skillName: entry.id };
}

class VellumSkillsCatalogTool implements Tool {
  name = 'vellum_skills_catalog';
  description = 'List and install Vellum-provided skills from the first-party catalog';
  category = 'skills';
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'install'],
            description: 'The operation to perform. "list" shows available skills; "install" copies a skill to managed skills.',
          },
          skill_id: {
            type: 'string',
            description: 'The skill ID to install (required for install action).',
          },
          overwrite: {
            type: 'boolean',
            description: 'Whether to overwrite if the skill is already installed (default: false).',
          },
        },
        required: ['action'],
      },
    };
  }

  async execute(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    const action = input.action as string;

    switch (action) {
      case 'list': {
        const entries = listCatalogEntries();
        if (entries.length === 0) {
          return { content: 'No Vellum-provided skills available in the catalog.', isError: false };
        }
        return { content: JSON.stringify(entries, null, 2), isError: false };
      }

      case 'install': {
        const skillId = input.skill_id;
        if (typeof skillId !== 'string' || !skillId.trim()) {
          return { content: 'Error: skill_id is required for install action', isError: true };
        }

        const catalogDir = getVellumSkillsDir();
        const skillDir = join(catalogDir, skillId.trim());
        const skillFilePath = join(skillDir, 'SKILL.md');

        if (!existsSync(skillFilePath)) {
          const available = listCatalogEntries().map((e) => e.id);
          return {
            content: `Error: skill "${skillId}" not found in the Vellum catalog. Available: ${available.join(', ') || 'none'}`,
            isError: true,
          };
        }

        const content = readFileSync(skillFilePath, 'utf-8');
        const match = content.match(FRONTMATTER_REGEX);
        if (!match) {
          return { content: `Error: skill "${skillId}" has invalid SKILL.md (missing frontmatter)`, isError: true };
        }

        const entry = parseCatalogEntry(skillDir);
        if (!entry) {
          return { content: `Error: skill "${skillId}" has invalid SKILL.md`, isError: true };
        }

        const bodyMarkdown = content.slice(match[0].length);

        const result = createManagedSkill({
          id: entry.id,
          name: entry.name,
          description: entry.description,
          bodyMarkdown,
          emoji: entry.emoji,
          includes: entry.includes,
          overwrite: input.overwrite === true,
          addToIndex: true,
        });

        if (!result.created) {
          return { content: `Error: ${result.error}`, isError: true };
        }

        return {
          content: JSON.stringify({
            installed: true,
            skill_id: entry.id,
            name: entry.name,
            path: result.path,
          }),
          isError: false,
        };
      }

      default:
        return { content: `Error: unknown action "${action}". Use "list" or "install".`, isError: true };
    }
  }
}

export const vellumSkillsCatalogTool: Tool = new VellumSkillsCatalogTool();

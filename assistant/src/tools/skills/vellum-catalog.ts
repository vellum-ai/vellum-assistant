import { RiskLevel } from '../../permissions/types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { createManagedSkill } from '../../skills/managed-store.js';
import { fetchCatalogEntries, fetchSkillContent, isVellumSkill } from '../../skills/vellum-catalog-remote.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  emoji?: string;
  includes?: string[];
}

export { fetchCatalogEntries as listCatalogEntries, isVellumSkill };

/**
 * Install a skill from the vellum-skills catalog by ID.
 * Fetches SKILL.md from GitHub (with bundled fallback) and creates a managed skill.
 * Returns { success, skillName, error }.
 */
export async function installFromVellumCatalog(skillId: string): Promise<{ success: boolean; skillName?: string; error?: string }> {
  const trimmedId = skillId.trim();

  // Verify skill exists in catalog
  const exists = await isVellumSkill(trimmedId);
  if (!exists) {
    return { success: false, error: `Skill "${trimmedId}" not found in the Vellum catalog` };
  }

  // Fetch SKILL.md content (remote with bundled fallback)
  const content = await fetchSkillContent(trimmedId);
  if (!content) {
    return { success: false, error: `Skill "${trimmedId}" SKILL.md not found` };
  }

  const match = content.match(FRONTMATTER_REGEX);
  if (!match) {
    return { success: false, error: `Skill "${trimmedId}" has invalid SKILL.md` };
  }

  // Parse frontmatter to get name/description/emoji/includes
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
  if (!name || !description) {
    return { success: false, error: `Skill "${trimmedId}" has invalid SKILL.md (missing name or description)` };
  }

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

  const bodyMarkdown = content.slice(match[0].length);
  const result = createManagedSkill({
    id: trimmedId,
    name,
    description,
    bodyMarkdown,
    emoji,
    includes,
    overwrite: true,
    addToIndex: true,
  });

  if (!result.created) {
    return { success: false, error: result.error };
  }

  return { success: true, skillName: trimmedId };
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
        const entries = await fetchCatalogEntries();
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

        const result = await installFromVellumCatalog(skillId);
        if (!result.success) {
          return { content: `Error: ${result.error}`, isError: true };
        }

        return {
          content: JSON.stringify({
            installed: true,
            skill_id: result.skillName,
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

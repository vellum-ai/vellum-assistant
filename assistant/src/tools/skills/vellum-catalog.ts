import { RiskLevel } from '../../permissions/types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { parseFrontmatterFields } from '../../skills/frontmatter.js';
import { createManagedSkill } from '../../skills/managed-store.js';
import { fetchCatalogEntries, fetchSkillContent, checkVellumSkill } from '../../skills/vellum-catalog-remote.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';

export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  emoji?: string;
  includes?: string[];
}

export { fetchCatalogEntries as listCatalogEntries, checkVellumSkill };

/**
 * Install a skill from the vellum-skills catalog by ID.
 * Fetches SKILL.md from GitHub (with bundled fallback) and creates a managed skill.
 * Returns { success, skillName, error }.
 */
export async function installFromVellumCatalog(skillId: string, options?: { overwrite?: boolean }): Promise<{ success: boolean; skillName?: string; error?: string }> {
  const trimmedId = skillId.trim();

  // Verify skill exists in catalog
  const exists = await checkVellumSkill(trimmedId);
  if (!exists) {
    return { success: false, error: `Skill "${trimmedId}" not found in the Vellum catalog` };
  }

  // Fetch SKILL.md content (remote with bundled fallback)
  const content = await fetchSkillContent(trimmedId);
  if (!content) {
    return { success: false, error: `Skill "${trimmedId}" SKILL.md not found` };
  }

  const parsed = parseFrontmatterFields(content);
  if (!parsed) {
    return { success: false, error: `Skill "${trimmedId}" has invalid SKILL.md` };
  }

  const { fields, body: bodyMarkdown } = parsed;

  const name = fields.name?.trim();
  const description = fields.description?.trim();
  if (!name || !description) {
    return { success: false, error: `Skill "${trimmedId}" has invalid SKILL.md (missing name or description)` };
  }

  let emoji: string | undefined;
  const metadataRaw = fields.metadata?.trim();
  if (metadataRaw) {
    try {
      const metaObj = JSON.parse(metadataRaw);
      if (metaObj?.vellum?.emoji) {
        emoji = metaObj.vellum.emoji as string;
      }
    } catch {
      // ignore malformed metadata
    }
  }

  let includes: string[] | undefined;
  const includesRaw = fields.includes?.trim();
  if (includesRaw) {
    try {
      const includesObj = JSON.parse(includesRaw);
      if (Array.isArray(includesObj) && includesObj.every((item: unknown) => typeof item === 'string')) {
        const filtered = (includesObj as string[]).map((s) => s.trim()).filter((s) => s.length > 0);
        if (filtered.length > 0) includes = filtered;
      }
    } catch {
      // ignore malformed includes
    }
  }
  const result = createManagedSkill({
    id: trimmedId,
    name,
    description,
    bodyMarkdown,
    emoji,
    includes,
    overwrite: options?.overwrite ?? true,
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

        const result = await installFromVellumCatalog(skillId, { overwrite: input.overwrite === true });
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

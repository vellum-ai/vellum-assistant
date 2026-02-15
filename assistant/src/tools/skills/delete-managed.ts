import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { registerTool } from '../registry.js';
import { deleteManagedSkill } from '../../skills/managed-store.js';

export class DeleteManagedSkillTool implements Tool {
  name = 'delete_managed_skill';
  description = 'Delete a managed skill from ~/.vellum/skills and remove it from the SKILLS.md index.';
  category = 'skills';
  defaultRiskLevel = RiskLevel.High;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          skill_id: {
            type: 'string',
            description: 'The ID of the managed skill to delete.',
          },
          remove_from_index: {
            type: 'boolean',
            description: 'Whether to remove the skill from SKILLS.md index (default: true).',
          },
        },
        required: ['skill_id'],
      },
    };
  }

  async execute(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    const skillId = input.skill_id;
    if (typeof skillId !== 'string' || !skillId.trim()) {
      return { content: 'Error: skill_id is required and must be a non-empty string', isError: true };
    }

    const removeFromIndex = input.remove_from_index !== false;

    const result = deleteManagedSkill(skillId.trim(), removeFromIndex);

    if (!result.deleted) {
      return { content: `Error: ${result.error}`, isError: true };
    }

    return {
      content: JSON.stringify({
        deleted: true,
        skill_id: skillId.trim(),
        index_updated: result.indexUpdated,
      }),
      isError: false,
    };
  }
}

export const deleteManagedSkillTool: Tool = new DeleteManagedSkillTool();
registerTool(deleteManagedSkillTool);

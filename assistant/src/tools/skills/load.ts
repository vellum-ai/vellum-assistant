import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { registerTool } from '../registry.js';
import { loadSkillBySelector } from '../../config/skills.js';

class SkillLoadTool implements Tool {
  name = 'skill_load';
  description = 'Load full instructions for a configured skill from ~/.vellum/skills.';
  category = 'skills';
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          skill: {
            type: 'string',
            description: 'The skill id or skill name to load.',
          },
        },
        required: ['skill'],
      },
    };
  }

  async execute(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    const selector = input.skill;
    if (typeof selector !== 'string' || selector.trim().length === 0) {
      return { content: 'Error: skill is required and must be a non-empty string', isError: true };
    }

    const loaded = loadSkillBySelector(selector);
    if (!loaded.skill) {
      return { content: `Error: ${loaded.error ?? 'Failed to load skill'}`, isError: true };
    }

    const skill = loaded.skill;
    const body = skill.body.length > 0 ? skill.body : '(No body content)';
    return {
      content: [
        `Skill: ${skill.name}`,
        `ID: ${skill.id}`,
        `Description: ${skill.description}`,
        `Path: ${skill.skillFilePath}`,
        '',
        body,
      ].join('\n'),
      isError: false,
    };
  }
}

registerTool(new SkillLoadTool());

import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { registerTool } from '../registry.js';
import { loadSkillBySelector } from '../../config/skills.js';
import { computeSkillVersionHash } from '../../skills/version-hash.js';
import { getLogger } from '../../util/logger.js';

const log = getLogger('skill-load');

export class SkillLoadTool implements Tool {
  name = 'skill_load';
  description = 'Load full instructions for a configured skill from ~/.vellum/workspace/skills.';
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
          version_hash: {
            type: 'string',
            description: 'Optional pre-computed version hash for the skill. Used by the permission system to generate version-specific trust rules.',
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

    let versionHash: string | undefined;
    try {
      versionHash = computeSkillVersionHash(skill.directoryPath);
    } catch (err) {
      log.warn({ err, skillId: skill.id }, 'Failed to compute skill version hash for marker');
    }

    const versionAttr = versionHash ? ` version="${versionHash}"` : '';
    return {
      content: [
        `Skill: ${skill.name}`,
        `ID: ${skill.id}`,
        `Description: ${skill.description}`,
        `Path: ${skill.skillFilePath}`,
        '',
        body,
        '',
        `<loaded_skill id="${skill.id}"${versionAttr} />`,
      ].join('\n'),
      isError: false,
    };
  }
}

registerTool(new SkillLoadTool());

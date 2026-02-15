import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { registerTool } from '../registry.js';
import { createManagedSkill } from '../../skills/managed-store.js';

/** Strip embedded newlines/carriage returns to prevent YAML frontmatter injection. */
function sanitizeFrontmatterValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

export class ScaffoldManagedSkillTool implements Tool {
  name = 'scaffold_managed_skill';
  description = 'Create or update a managed skill in ~/.vellum/skills. The skill becomes available for skill_load immediately.';
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
            description: 'Unique identifier for the skill (lowercase slug, e.g. "my-skill").',
          },
          name: {
            type: 'string',
            description: 'Human-readable name for the skill.',
          },
          description: {
            type: 'string',
            description: 'Short description of what the skill does.',
          },
          body_markdown: {
            type: 'string',
            description: 'The full skill body in markdown — instructions, prompts, templates, etc.',
          },
          emoji: {
            type: 'string',
            description: 'Optional emoji icon for the skill.',
          },
          user_invocable: {
            type: 'boolean',
            description: 'Whether users can invoke this skill directly (default: true).',
          },
          disable_model_invocation: {
            type: 'boolean',
            description: 'Whether to prevent the model from auto-invoking this skill (default: false).',
          },
          overwrite: {
            type: 'boolean',
            description: 'Whether to overwrite an existing skill with the same ID (default: false).',
          },
          add_to_index: {
            type: 'boolean',
            description: 'Whether to add the skill to SKILLS.md index (default: true).',
          },
        },
        required: ['skill_id', 'name', 'description', 'body_markdown'],
      },
    };
  }

  async execute(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    const skillId = input.skill_id;
    if (typeof skillId !== 'string' || !skillId.trim()) {
      return { content: 'Error: skill_id is required and must be a non-empty string', isError: true };
    }

    const name = input.name;
    if (typeof name !== 'string' || !name.trim()) {
      return { content: 'Error: name is required and must be a non-empty string', isError: true };
    }

    const description = input.description;
    if (typeof description !== 'string' || !description.trim()) {
      return { content: 'Error: description is required and must be a non-empty string', isError: true };
    }

    const bodyMarkdown = input.body_markdown;
    if (typeof bodyMarkdown !== 'string' || !bodyMarkdown.trim()) {
      return { content: 'Error: body_markdown is required and must be a non-empty string', isError: true };
    }

    const result = createManagedSkill({
      id: skillId.trim(),
      name: sanitizeFrontmatterValue(name),
      description: sanitizeFrontmatterValue(description),
      bodyMarkdown: bodyMarkdown,
      emoji: typeof input.emoji === 'string' ? sanitizeFrontmatterValue(input.emoji) : undefined,
      userInvocable: typeof input.user_invocable === 'boolean' ? input.user_invocable : undefined,
      disableModelInvocation: typeof input.disable_model_invocation === 'boolean' ? input.disable_model_invocation : undefined,
      overwrite: input.overwrite === true,
      addToIndex: input.add_to_index !== false,
    });

    if (!result.created) {
      return { content: `Error: ${result.error}`, isError: true };
    }

    return {
      content: JSON.stringify({
        created: true,
        skill_id: skillId.trim(),
        path: result.path,
        index_updated: result.indexUpdated,
      }),
      isError: false,
    };
  }
}

export const scaffoldManagedSkillTool: Tool = new ScaffoldManagedSkillTool();
registerTool(scaffoldManagedSkillTool);

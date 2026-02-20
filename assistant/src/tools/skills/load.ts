import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { registerTool } from '../registry.js';
import { loadSkillBySelector, loadSkillCatalog } from '../../config/skills.js';
import type { SkillSummary } from '../../config/skills.js';
import { indexCatalogById, validateIncludes } from '../../skills/include-graph.js';
import { computeSkillVersionHash } from '../../skills/version-hash.js';
import { getLogger } from '../../util/logger.js';
import { discoverCCCommands } from '../../commands/cc-command-registry.js';
import type { CCCommandEntry } from '../../commands/cc-command-registry.js';

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
        },
        required: ['skill'],
      },
    };
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    const selector = input.skill;
    if (typeof selector !== 'string' || selector.trim().length === 0) {
      return { content: 'Error: skill is required and must be a non-empty string', isError: true };
    }

    const loaded = loadSkillBySelector(selector);
    if (!loaded.skill) {
      return { content: `Error: ${loaded.error ?? 'Failed to load skill'}`, isError: true };
    }

    const skill = loaded.skill;

    // Load catalog for include validation and child metadata output
    let catalogIndex: Map<string, SkillSummary> | undefined;
    if (skill.includes && skill.includes.length > 0) {
      const catalog = loadSkillCatalog();
      catalogIndex = indexCatalogById(catalog);

      // Validate recursive includes (fail-closed)
      const validation = validateIncludes(skill.id, catalogIndex);
      if (!validation.ok) {
        if (validation.error === 'missing') {
          return {
            content: `Error: skill "${skill.id}" includes "${validation.missingChildId}" which was not found (referenced by "${validation.parentId}" via path: ${validation.path.join(' → ')})`,
            isError: true,
          };
        }
        if (validation.error === 'cycle') {
          return {
            content: `Error: skill "${skill.id}" has a circular include chain: ${validation.cyclePath.join(' → ')}`,
            isError: true,
          };
        }
        return {
          content: `Error: skill "${skill.id}" has an invalid include graph`,
          isError: true,
        };
      }
    }

    const body = skill.body.length > 0 ? skill.body : '(No body content)';

    // Build immediate children metadata section
    let immediateChildrenSection: string;
    if (skill.includes && skill.includes.length > 0 && catalogIndex) {
      const childLines: string[] = [];
      for (const childId of skill.includes) {
        const child = catalogIndex.get(childId);
        if (child) {
          childLines.push(`  - ${child.id}: ${child.name} — ${child.description} (${child.skillFilePath})`);
        }
      }
      immediateChildrenSection = `Included Skills (immediate):\n${childLines.join('\n')}`;
    } else {
      immediateChildrenSection = 'Included Skills (immediate): none';
    }

    let versionHash: string | undefined;
    try {
      versionHash = computeSkillVersionHash(skill.directoryPath);
    } catch (err) {
      log.warn({ err, skillId: skill.id }, 'Failed to compute skill version hash for marker');
    }

    const versionAttr = versionHash ? ` version="${versionHash}"` : '';

    // Emit markers for included skills so their tools get projected
    const includeMarkers: string[] = [];
    if (skill.includes && skill.includes.length > 0 && catalogIndex) {
      for (const childId of skill.includes) {
        const child = catalogIndex.get(childId);
        if (!child) continue;
        let childHash: string | undefined;
        try {
          childHash = computeSkillVersionHash(child.directoryPath);
        } catch (err) {
          log.warn({ err, skillId: childId }, 'Failed to compute included skill version hash');
        }
        const childVersionAttr = childHash ? ` version="${childHash}"` : '';
        includeMarkers.push(`<loaded_skill id="${childId}"${childVersionAttr} />`);
      }
    }

    // When loading the claude-code skill, append available CC commands and skills
    let ccCommandsSection = '';
    if (skill.id === 'claude-code' && context.workingDir) {
      const ccRegistry = discoverCCCommands(context.workingDir);
      if (ccRegistry.entries.size > 0) {
        const commands: CCCommandEntry[] = [];
        const skills: CCCommandEntry[] = [];
        for (const [, entry] of ccRegistry.entries) {
          if (entry.artifactType === 'skill') {
            skills.push(entry);
          } else {
            commands.push(entry);
          }
        }

        const sections: string[] = [];
        if (commands.length > 0) {
          sections.push('Available Claude Code Commands (from .claude/commands/):');
          for (const entry of commands) {
            sections.push(`- /${entry.name}: ${entry.summary}`);
          }
        }
        if (skills.length > 0) {
          sections.push('Available Claude Code Skills (from .claude/skills/):');
          for (const entry of skills) {
            sections.push(`- /${entry.name}: ${entry.summary}`);
          }
        }
        sections.push('');
        sections.push('Users can invoke these with /command-name. You can execute them using the claude_code tool with the `command` parameter.');
        ccCommandsSection = '\n\n' + sections.join('\n');
      }
    }

    return {
      content: [
        `Skill: ${skill.name}`,
        `ID: ${skill.id}`,
        `Description: ${skill.description}`,
        `Path: ${skill.skillFilePath}`,
        '',
        body + ccCommandsSection,
        '',
        immediateChildrenSection,
        '',
        `<loaded_skill id="${skill.id}"${versionAttr} />`,
        ...includeMarkers,
      ].join('\n'),
      isError: false,
    };
  }
}

registerTool(new SkillLoadTool());

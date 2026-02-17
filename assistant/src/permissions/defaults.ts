import { join } from 'node:path';
import { getRootDir } from '../util/platform.js';
import { getBundledSkillsDir } from '../config/skills.js';

export interface DefaultRuleTemplate {
  id: string;
  tool: string;
  pattern: string;
  scope: string;
  decision: 'allow' | 'deny' | 'ask';
  priority: number;
}

/** Tools that directly access the filesystem by path. */
const FILE_TOOLS = ['file_read', 'file_write', 'file_edit'] as const;
const HOST_FILE_TOOLS = ['host_file_read', 'host_file_write', 'host_file_edit'] as const;
const COMPUTER_USE_TOOLS = [
  'computer_use_click',
  'computer_use_double_click',
  'computer_use_right_click',
  'computer_use_type_text',
  'computer_use_key',
  'computer_use_scroll',
  'computer_use_drag',
  'computer_use_wait',
  'computer_use_open_app',
  'computer_use_run_applescript',
  'request_computer_control',
  // computer_use_done and computer_use_respond are terminal signal tools
  // (RiskLevel.Low) — they don't perform any computer action, so they
  // should NOT get an 'ask' rule.
] as const;

/**
 * Returns default trust rules shipped with the assistant.
 * Computed at runtime so paths reflect the configured root directory.
 */
export function getDefaultRuleTemplates(): DefaultRuleTemplate[] {
  // Use forward slashes so minimatch patterns work on all platforms
  // (path.join produces backslashes on Windows, which minimatch treats as escapes).
  const protectedDir = join(getRootDir(), 'protected').replaceAll('\\', '/');

  const protectedFileRules = FILE_TOOLS.map((tool) => ({
    id: `default:ask-${tool}-protected`,
    tool,
    pattern: `${tool}:${protectedDir}/**`,
    scope: 'everywhere',
    decision: 'ask' as const,
    priority: 1000,
  }));

  const hostFileRules = HOST_FILE_TOOLS.map((tool) => ({
    id: `default:ask-${tool}-global`,
    tool,
    pattern: `${tool}:/**`,
    scope: 'everywhere',
    decision: 'ask' as const,
    priority: 50,
  }));

  // host_bash command candidates are raw commands ("ls", "npm test"), so the
  // global default ask rule uses "**" (globstar) instead of a "tool:*" prefix
  // because commands often contain "/" (e.g. "cat /etc/hosts").
  const hostShellRule: DefaultRuleTemplate = {
    id: 'default:ask-host_bash-global',
    tool: 'host_bash',
    pattern: '**',
    scope: 'everywhere',
    decision: 'ask',
    priority: 50,
  };

  // Standalone "**" globstar — minimatch only treats ** as globstar when it is
  // its own path segment, so a "tool:**" prefix would collapse to single-star
  // behavior and fail to match candidates containing "/".  The tool is already
  // filtered by `findHighestPriorityRule` (rule.tool !== tool), so a prefix is
  // unnecessary.
  const computerUseRules = COMPUTER_USE_TOOLS.map((tool) => ({
    id: `default:ask-${tool}-global`,
    tool,
    pattern: '**',
    scope: 'everywhere',
    decision: 'ask' as const,
    priority: 1000,
  }));

  // Managed skill authoring tools — scaffold and delete modify ~/.vellum/workspace/skills/
  // and should require explicit user approval.
  const MANAGED_SKILL_TOOLS = ['scaffold_managed_skill', 'delete_managed_skill'] as const;
  const managedSkillRules = MANAGED_SKILL_TOOLS.map((tool) => ({
    id: `default:ask-${tool}-global`,
    tool,
    pattern: `${tool}:*`,
    scope: 'everywhere',
    decision: 'ask' as const,
    priority: 1000,
  }));

  // Workspace prompt files — the agent should always be able to read, edit,
  // and write these without prompting.  Also allow `rm BOOTSTRAP.md` so the
  // agent can delete it at the end of the onboarding ritual.
  const workspaceDir = join(getRootDir(), 'workspace').replaceAll('\\', '/');
  const WORKSPACE_PROMPT_FILES = ['IDENTITY.md', 'USER.md', 'SOUL.md', 'BOOTSTRAP.md'] as const;
  const WORKSPACE_FILE_TOOLS = ['file_read', 'file_write', 'file_edit'] as const;
  const workspacePromptRules = WORKSPACE_FILE_TOOLS.flatMap((tool) =>
    WORKSPACE_PROMPT_FILES.map((file) => ({
      id: `default:allow-${tool}-${file.toLowerCase().replace('.md', '')}`,
      tool,
      pattern: `${tool}:${workspaceDir}/${file}`,
      scope: 'everywhere',
      decision: 'allow' as const,
      priority: 100,
    })),
  );

  const bootstrapDeleteRule: DefaultRuleTemplate = {
    id: 'default:allow-bash-rm-bootstrap',
    tool: 'bash',
    pattern: 'rm BOOTSTRAP.md',
    scope: workspaceDir,
    decision: 'allow',
    priority: 100,
  };

  // Skill source directories — writing or editing skill source files should
  // require explicit user approval so a compromised agent loop cannot silently
  // modify skill code to escalate privileges.
  const managedSkillsDir = join(getRootDir(), 'workspace', 'skills').replaceAll('\\', '/');
  const bundledSkillsDir = getBundledSkillsDir().replaceAll('\\', '/');
  const SKILL_MUTATION_TOOLS = ['file_write', 'file_edit'] as const;
  const HOST_SKILL_MUTATION_TOOLS = ['host_file_write', 'host_file_edit'] as const;
  const skillDirs = [
    { dir: managedSkillsDir, label: 'managed' },
    { dir: bundledSkillsDir, label: 'bundled' },
  ];

  const skillSourceMutationRules = skillDirs.flatMap(({ dir, label }) => [
    ...SKILL_MUTATION_TOOLS.map((tool) => ({
      id: `default:ask-${tool}-${label}-skills`,
      tool,
      pattern: `${tool}:${dir}/**`,
      scope: 'everywhere',
      decision: 'ask' as const,
      priority: 50,
    })),
    ...HOST_SKILL_MUTATION_TOOLS.map((tool) => ({
      id: `default:ask-${tool}-${label}-skills`,
      tool,
      pattern: `${tool}:${dir}/**`,
      scope: 'everywhere',
      decision: 'ask' as const,
      priority: 50,
    })),
  ]);

  return [
    ...protectedFileRules,
    ...hostFileRules,
    hostShellRule,
    ...computerUseRules,
    ...managedSkillRules,
    ...workspacePromptRules,
    bootstrapDeleteRule,
    ...skillSourceMutationRules,
  ];
}

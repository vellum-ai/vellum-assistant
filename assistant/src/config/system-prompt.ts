import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '../util/platform.js';
import { getLogger } from '../util/logger.js';
import { DEFAULT_SYSTEM_PROMPT } from './defaults.js';
import { loadSkillCatalog, type SkillSummary } from './skills.js';

const log = getLogger('system-prompt');

/**
 * Build the system prompt from ~/.vellum prompt files and configured fallback,
 * then append a generated skills catalog (if any skills are available).
 *
 * Priority:
 *   1. Base prompt: SOUL.md and/or IDENTITY.md when present
 *   2. Base prompt fallback: config.systemPrompt
 *   3. Base prompt fallback: DEFAULT_SYSTEM_PROMPT
 *   4. Append skills catalog from ~/.vellum/skills
 *
 * When both IDENTITY.md and SOUL.md exist, the base prompt is composed as:
 *   IDENTITY.md content + "\n\n" + SOUL.md content
 */
export function buildSystemPrompt(configSystemPrompt?: string): string {
  const baseDir = getDataDir();
  const soulPath = join(baseDir, 'SOUL.md');
  const identityPath = join(baseDir, 'IDENTITY.md');

  const soul = readPromptFile(soulPath);
  const identity = readPromptFile(identityPath);

  let basePrompt = configSystemPrompt ?? DEFAULT_SYSTEM_PROMPT;

  if (identity || soul) {
    const parts: string[] = [];
    if (identity) parts.push(identity);
    if (soul) parts.push(soul);
    basePrompt = parts.join('\n\n');
  }

  return appendSkillsCatalog(basePrompt);
}

function readPromptFile(path: string): string | null {
  if (!existsSync(path)) return null;

  try {
    const content = readFileSync(path, 'utf-8').trim();
    if (content.length === 0) return null;
    log.debug({ path }, 'Loaded prompt file');
    return content;
  } catch (err) {
    log.warn({ err, path }, 'Failed to read prompt file');
    return null;
  }
}

function appendSkillsCatalog(basePrompt: string): string {
  const skills = loadSkillCatalog();
  if (skills.length === 0) return basePrompt;

  const catalog = formatSkillsCatalog(skills);
  return `${basePrompt}\n\n${catalog}`;
}

function formatSkillsCatalog(skills: SkillSummary[]): string {
  const lines: string[] = [
    '## Skills Catalog',
    'The following skills are available. Before executing one, call the `skill_load` tool with its id or name to load the full instructions.',
    '',
  ];

  for (const skill of skills) {
    lines.push(`- \`${skill.id}\` - ${skill.name}: ${skill.description}`);
  }

  return lines.join('\n');
}

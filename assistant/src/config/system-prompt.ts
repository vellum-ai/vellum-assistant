import { readFileSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { getRootDir } from '../util/platform.js';
import { getLogger } from '../util/logger.js';
import { loadSkillCatalog, type SkillSummary } from './skills.js';

const log = getLogger('system-prompt');

const PROMPT_FILES = ['SOUL.md', 'IDENTITY.md', 'USER.md'] as const;

/**
 * Copy template prompt files into the data directory if they don't already exist.
 * Called once during daemon startup so users always have discoverable files to edit.
 */
export function ensurePromptFiles(): void {
  const dataDir = getRootDir();
  const templatesDir = join(import.meta.dirname ?? __dirname, 'templates');

  for (const file of PROMPT_FILES) {
    const dest = join(dataDir, file);
    if (existsSync(dest)) continue;

    const src = join(templatesDir, file);
    try {
      if (!existsSync(src)) {
        log.warn({ src }, 'Prompt template not found, skipping');
        continue;
      }
      copyFileSync(src, dest);
      log.info({ file, dest }, 'Created prompt file from template');
    } catch (err) {
      log.warn({ err, file }, 'Failed to create prompt file from template');
    }
  }
}

/**
 * Build the system prompt from ~/.vellum prompt files,
 * then append a generated skills catalog (if any skills are available).
 *
 * Composition:
 *   1. Base prompt: IDENTITY.md + SOUL.md (guaranteed to exist after ensurePromptFiles)
 *   2. Append USER.md (user profile)
 *   3. Append skills catalog from ~/.vellum/skills
 */
export function buildSystemPrompt(): string {
  const baseDir = getRootDir();
  const soulPath = join(baseDir, 'SOUL.md');
  const identityPath = join(baseDir, 'IDENTITY.md');
  const userPath = join(baseDir, 'USER.md');

  const soul = readPromptFile(soulPath);
  const identity = readPromptFile(identityPath);
  const user = readPromptFile(userPath);

  const parts: string[] = [];
  if (identity) parts.push(identity);
  if (soul) parts.push(soul);
  if (user) parts.push(user);
  parts.push(buildConfigSection(baseDir));

  return appendSkillsCatalog(parts.join('\n\n'));
}

function buildConfigSection(configDir: string): string {
  return [
    '## Configuration',
    `Your configuration directory is \`${configDir}/\`. Key files you may read or edit:`,
    '',
    '- `IDENTITY.md` — Your name, role, and tone. Edit to change your persona.',
    '- `SOUL.md` — Core principles and behavioral boundaries.',
    '- `USER.md` — Profile of the user. Update as you learn about them over time.',
    '- `skills/` — Directory of installed skills (loaded automatically at startup).',
  ].join('\n');
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

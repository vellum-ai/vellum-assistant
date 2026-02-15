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
  parts.push(buildAttachmentSection());

  return appendSkillsCatalog(parts.join('\n\n'));
}

function buildAttachmentSection(): string {
  return [
    '## Sending Files and Images',
    '',
    'To attach a file or image to your reply, include a self-closing XML tag in your response text:',
    '',
    '```',
    '<vellum-attachment source="sandbox" path="output/chart.png" />',
    '```',
    '',
    '- `source`: `sandbox` (default, files inside the sandbox working directory) or `host` (absolute paths on the host filesystem — requires user approval).',
    '- `path`: Required. Relative path for sandbox, absolute path for host.',
    '- `filename`: Optional override for the delivered filename (defaults to the basename of the path).',
    '- `mime_type`: Optional MIME type override (inferred from the file extension if omitted).',
    '',
    'Limits: up to 5 attachments per turn, 20 MB each. Tool outputs that produce image or file content blocks are also automatically converted into attachments.',
  ].join('\n');
}

function buildConfigSection(configDir: string): string {
  return [
    '## Configuration',
    `Your configuration directory is \`${configDir}/\`. Key files you may read or edit:`,
    '',
    '- `IDENTITY.md` — Your name and role. Slim metadata — rarely changes.',
    '- `SOUL.md` — Core principles, personality, and evolution guidance. Your behavioral foundation.',
    '- `USER.md` — Profile of the user. Update as you learn about them over time.',
    '- `skills/` — Directory of installed skills (loaded automatically at startup).',
  ].join('\n');
}

/**
 * Strip lines starting with `_` (comment convention for prompt .md files)
 * and collapse any resulting consecutive blank lines.
 *
 * Lines inside fenced code blocks (``` or ~~~ delimiters per CommonMark)
 * are never stripped, so code examples with `_`-prefixed identifiers are preserved.
 */
export function stripCommentLines(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n');
  let openFenceChar: string | null = null;
  const filtered = normalized.split('\n').filter((line) => {
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const char = fenceMatch[1][0];
      if (!openFenceChar) {
        openFenceChar = char;
      } else if (char === openFenceChar) {
        openFenceChar = null;
      }
    }
    if (openFenceChar) return true;
    return !line.trimStart().startsWith('_');
  });
  return filtered
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function readPromptFile(path: string): string | null {
  if (!existsSync(path)) return null;

  try {
    const content = stripCommentLines(readFileSync(path, 'utf-8'));
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
  if (!catalog) return basePrompt;
  return `${basePrompt}\n\n${catalog}`;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatSkillsCatalog(skills: SkillSummary[]): string {
  // Filter out skills with disableModelInvocation
  const visible = skills.filter(s => !s.disableModelInvocation);
  if (visible.length === 0) return '';

  const lines = ['<available_skills>'];
  for (const skill of visible) {
    const idAttr = escapeXml(skill.id);
    const nameAttr = escapeXml(skill.name);
    const descAttr = escapeXml(skill.description);
    const locAttr = escapeXml(skill.directoryPath);
    lines.push(`<skill id="${idAttr}" name="${nameAttr}" description="${descAttr}" location="${locAttr}" />`);
  }
  lines.push('</available_skills>');

  return [
    '## Available Skills',
    'The following skills are available. Before executing one, call the `skill_load` tool with its `id` to load the full instructions.',
    '',
    lines.join('\n'),
  ].join('\n');
}

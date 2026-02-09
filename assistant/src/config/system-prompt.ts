import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '../util/platform.js';
import { getLogger } from '../util/logger.js';
import { DEFAULT_SYSTEM_PROMPT } from './defaults.js';

const log = getLogger('system-prompt');

/**
 * Build the system prompt by composing optional SOUL.md and IDENTITY.md files
 * from ~/.vellum/. Falls back to the config systemPrompt or DEFAULT_SYSTEM_PROMPT.
 *
 * Priority:
 *   1. If SOUL.md and/or IDENTITY.md exist, compose from those files
 *   2. If config.systemPrompt is set, use it
 *   3. Otherwise, use DEFAULT_SYSTEM_PROMPT
 *
 * When both SOUL.md and IDENTITY.md exist, the prompt is composed as:
 *   IDENTITY.md content + "\n\n" + SOUL.md content
 */
export function buildSystemPrompt(configSystemPrompt?: string): string {
  const baseDir = getDataDir();
  const soulPath = join(baseDir, 'SOUL.md');
  const identityPath = join(baseDir, 'IDENTITY.md');

  const soul = readPromptFile(soulPath);
  const identity = readPromptFile(identityPath);

  if (identity || soul) {
    const parts: string[] = [];
    if (identity) parts.push(identity);
    if (soul) parts.push(soul);
    return parts.join('\n\n');
  }

  return configSystemPrompt ?? DEFAULT_SYSTEM_PROMPT;
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

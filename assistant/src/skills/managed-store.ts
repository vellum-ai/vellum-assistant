import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getRootDir } from '../util/platform.js';
import { getLogger } from '../util/logger.js';

const log = getLogger('managed-store');

// ─── Validation ──────────────────────────────────────────────────────────────

const VALID_SKILL_ID = /^[a-z0-9][a-z0-9._-]*$/;

export function validateManagedSkillId(id: string): string | null {
  if (!id || typeof id !== 'string') return 'skill_id is required';
  if (id.includes('..') || id.includes('/') || id.includes('\\')) {
    return 'skill_id must not contain path traversal characters';
  }
  if (!VALID_SKILL_ID.test(id)) {
    return 'skill_id must start with a lowercase letter or digit and contain only lowercase letters, digits, dots, hyphens, and underscores';
  }
  return null;
}

// ─── Path helpers ────────────────────────────────────────────────────────────

export function getManagedSkillsDir(): string {
  return join(getRootDir(), 'skills');
}

export function getManagedSkillDir(id: string): string {
  return join(getManagedSkillsDir(), id);
}

function getSkillsIndexPath(): string {
  return join(getManagedSkillsDir(), 'SKILLS.md');
}

// ─── SKILL.md generation ─────────────────────────────────────────────────────

export interface BuildSkillMarkdownInput {
  name: string;
  description: string;
  bodyMarkdown: string;
  emoji?: string;
  userInvocable?: boolean;
  disableModelInvocation?: boolean;
}

export function buildSkillMarkdown(input: BuildSkillMarkdownInput): string {
  const lines: string[] = ['---'];
  lines.push(`name: "${input.name}"`);
  lines.push(`description: "${input.description}"`);
  if (input.emoji) {
    lines.push(`emoji: "${input.emoji}"`);
  }
  if (input.userInvocable === false) {
    lines.push('user-invocable: false');
  }
  if (input.disableModelInvocation === true) {
    lines.push('disable-model-invocation: true');
  }
  lines.push('---');
  lines.push('');
  lines.push(input.bodyMarkdown);
  // Ensure trailing newline
  const content = lines.join('\n');
  return content.endsWith('\n') ? content : content + '\n';
}

// ─── Atomic write ────────────────────────────────────────────────────────────

function atomicWriteFile(filePath: string, content: string): void {
  const dir = dirname(filePath);
  const tmpPath = join(dir, `.tmp-${randomUUID()}`);
  writeFileSync(tmpPath, content, 'utf-8');
  renameSync(tmpPath, filePath);
}

// ─── SKILLS.md index management ──────────────────────────────────────────────

function readIndexLines(): string[] {
  const indexPath = getSkillsIndexPath();
  if (!existsSync(indexPath)) return [];
  return readFileSync(indexPath, 'utf-8').split('\n');
}

function writeIndexLines(lines: string[]): void {
  const content = lines.join('\n');
  atomicWriteFile(getSkillsIndexPath(), content.endsWith('\n') ? content : content + '\n');
}

function indexEntryRegex(id: string): RegExp {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^-\\s+(?:\\[.*?\\]\\()?${escaped}(?:\\))?(?:/SKILL\\.md)?\\s*$`);
}

export function upsertSkillsIndexEntry(id: string): void {
  const lines = readIndexLines();
  const pattern = indexEntryRegex(id);
  if (lines.some((line) => pattern.test(line))) {
    return; // already present
  }
  // Append new entry
  const nonEmpty = lines.filter((l) => l.trim());
  nonEmpty.push(`- ${id}`);
  writeIndexLines(nonEmpty);
  log.info({ id }, 'Added managed skill to SKILLS.md index');
}

export function removeSkillsIndexEntry(id: string): void {
  const lines = readIndexLines();
  const pattern = indexEntryRegex(id);
  const filtered = lines.filter((line) => !pattern.test(line));
  if (filtered.length === lines.length) {
    return; // not found
  }
  writeIndexLines(filtered.filter((l) => l.trim()));
  log.info({ id }, 'Removed managed skill from SKILLS.md index');
}

// ─── Create / Delete ─────────────────────────────────────────────────────────

export interface CreateManagedSkillParams {
  id: string;
  name: string;
  description: string;
  bodyMarkdown: string;
  emoji?: string;
  userInvocable?: boolean;
  disableModelInvocation?: boolean;
  overwrite?: boolean;
  addToIndex?: boolean;
}

export interface CreateManagedSkillResult {
  created: boolean;
  path: string;
  indexUpdated: boolean;
  error?: string;
}

export function createManagedSkill(params: CreateManagedSkillParams): CreateManagedSkillResult {
  const validationError = validateManagedSkillId(params.id);
  if (validationError) {
    return { created: false, path: '', indexUpdated: false, error: validationError };
  }

  const skillDir = getManagedSkillDir(params.id);
  const skillFilePath = join(skillDir, 'SKILL.md');

  if (existsSync(skillFilePath) && !params.overwrite) {
    return {
      created: false,
      path: skillFilePath,
      indexUpdated: false,
      error: `Managed skill "${params.id}" already exists. Set overwrite=true to replace it.`,
    };
  }

  const content = buildSkillMarkdown({
    name: params.name,
    description: params.description,
    bodyMarkdown: params.bodyMarkdown,
    emoji: params.emoji,
    userInvocable: params.userInvocable,
    disableModelInvocation: params.disableModelInvocation,
  });

  mkdirSync(skillDir, { recursive: true });
  atomicWriteFile(skillFilePath, content);
  log.info({ id: params.id, path: skillFilePath }, 'Created managed skill');

  let indexUpdated = false;
  if (params.addToIndex !== false) {
    upsertSkillsIndexEntry(params.id);
    indexUpdated = true;
  }

  return { created: true, path: skillFilePath, indexUpdated };
}

export interface DeleteManagedSkillResult {
  deleted: boolean;
  indexUpdated: boolean;
  error?: string;
}

export function deleteManagedSkill(
  id: string,
  removeFromIndex = true,
): DeleteManagedSkillResult {
  const validationError = validateManagedSkillId(id);
  if (validationError) {
    return { deleted: false, indexUpdated: false, error: validationError };
  }

  const skillDir = getManagedSkillDir(id);
  if (!existsSync(skillDir)) {
    return { deleted: false, indexUpdated: false, error: `Managed skill "${id}" not found` };
  }

  rmSync(skillDir, { recursive: true });
  log.info({ id, path: skillDir }, 'Deleted managed skill');

  let indexUpdated = false;
  if (removeFromIndex) {
    removeSkillsIndexEntry(id);
    indexUpdated = true;
  }

  return { deleted: true, indexUpdated };
}

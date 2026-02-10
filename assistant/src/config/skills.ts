import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { getDataDir } from '../util/platform.js';
import { getLogger } from '../util/logger.js';

const log = getLogger('skills');

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  directoryPath: string;
  skillFilePath: string;
}

export interface SkillDefinition extends SkillSummary {
  body: string;
}

export interface SkillLookupResult {
  skill?: SkillDefinition;
  error?: string;
}

export interface SkillSelectorResult {
  skill?: SkillSummary;
  error?: string;
}

export function getSkillsDir(): string {
  return join(getDataDir(), 'skills');
}

function getSkillsIndexPath(skillsDir: string): string {
  return join(skillsDir, 'SKILLS.md');
}

interface ParsedFrontmatter {
  name: string;
  description: string;
  body: string;
}

function parseFrontmatter(content: string, skillFilePath: string): ParsedFrontmatter | null {
  const match = content.match(FRONTMATTER_REGEX);
  if (!match) {
    log.warn({ skillFilePath }, 'Skipping skill without YAML frontmatter');
    return null;
  }

  const frontmatter = match[1];
  const fields: Record<string, string> = {};
  for (const line of frontmatter.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separatorIndex = trimmed.indexOf(':');
    if (separatorIndex === -1) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith('\'') && value.endsWith('\''))
    ) {
      value = value.slice(1, -1);
    }
    fields[key] = value;
  }

  const name = fields.name?.trim();
  const description = fields.description?.trim();
  if (!name || !description) {
    log.warn({ skillFilePath }, 'Skipping skill missing required frontmatter keys "name" and/or "description"');
    return null;
  }

  return {
    name,
    description,
    body: content.slice(match[0].length).trim(),
  };
}

function getCanonicalPath(path: string): string {
  return existsSync(path) ? realpathSync(path) : resolve(path);
}

function getRelativeToSkillsRoot(skillsDir: string, candidatePath: string): string {
  return relative(getCanonicalPath(skillsDir), getCanonicalPath(candidatePath));
}

function isOutsideSkillsRoot(skillsDir: string, candidatePath: string): boolean {
  const relativePath = getRelativeToSkillsRoot(skillsDir, candidatePath);
  return relativePath.startsWith('..') || isAbsolute(relativePath);
}

function readSkillFromDirectory(directoryPath: string, skillsDir: string): SkillDefinition | null {
  const skillFilePath = join(directoryPath, 'SKILL.md');
  if (!existsSync(skillFilePath)) {
    log.warn({ directoryPath }, 'Skipping skill directory without SKILL.md');
    return null;
  }

  try {
    if (isOutsideSkillsRoot(skillsDir, directoryPath)) {
      log.warn({ directoryPath }, 'Skipping skill directory that resolves outside ~/.vellum/skills');
      return null;
    }

    const stat = statSync(skillFilePath);
    if (!stat.isFile()) {
      log.warn({ skillFilePath }, 'Skipping skill path because SKILL.md is not a file');
      return null;
    }

    if (isOutsideSkillsRoot(skillsDir, skillFilePath)) {
      log.warn({ skillFilePath }, 'Skipping SKILL.md that resolves outside ~/.vellum/skills');
      return null;
    }

    const content = readFileSync(skillFilePath, 'utf-8');
    const parsed = parseFrontmatter(content, skillFilePath);
    if (!parsed) return null;

    return {
      id: basename(directoryPath),
      name: parsed.name,
      description: parsed.description,
      directoryPath,
      skillFilePath,
      body: parsed.body,
    };
  } catch (err) {
    log.warn({ err, skillFilePath }, 'Failed to read skill file');
    return null;
  }
}

function parseIndexEntry(line: string): string | null {
  const bulletMatch = line.trim().match(/^[-*]\s+(.+)$/);
  if (!bulletMatch) return null;

  let entry = bulletMatch[1].trim();
  const markdownLinkMatch = entry.match(/^\[[^\]]+\]\(([^)]+)\)$/);
  if (markdownLinkMatch) {
    entry = markdownLinkMatch[1].trim();
  }

  if (entry.startsWith('`') && entry.endsWith('`')) {
    entry = entry.slice(1, -1).trim();
  }

  return entry.length > 0 ? entry : null;
}

function resolveIndexEntryToDirectory(skillsDir: string, entry: string): string | null {
  if (isAbsolute(entry)) {
    log.warn({ entry }, 'Skipping SKILLS.md entry because absolute paths are not allowed');
    return null;
  }

  const resolvedEntryPath = resolve(skillsDir, entry);
  const resolvedDirectory = basename(resolvedEntryPath).toLowerCase() === 'skill.md'
    ? dirname(resolvedEntryPath)
    : resolvedEntryPath;

  const relativePath = getRelativeToSkillsRoot(skillsDir, resolvedDirectory);
  if (relativePath.length === 0) {
    log.warn({ entry }, 'Skipping SKILLS.md entry that resolves to the skills root');
    return null;
  }
  if (isOutsideSkillsRoot(skillsDir, resolvedDirectory)) {
    log.warn(
      { entry, resolvedDirectory: getCanonicalPath(resolvedDirectory) },
      'Skipping SKILLS.md entry that resolves outside ~/.vellum/skills',
    );
    return null;
  }

  return resolvedDirectory;
}

function getIndexedSkillDirectories(skillsDir: string): string[] | null {
  const indexPath = getSkillsIndexPath(skillsDir);
  if (!existsSync(indexPath)) return null;

  let rawIndex = '';
  try {
    rawIndex = readFileSync(indexPath, 'utf-8');
  } catch (err) {
    log.warn({ err, indexPath }, 'Failed to read SKILLS.md; treating as empty catalog');
    return [];
  }

  const directories: string[] = [];
  const seen = new Set<string>();

  for (const line of rawIndex.split(/\r?\n/)) {
    const parsedEntry = parseIndexEntry(line);
    if (!parsedEntry) continue;

    const directory = resolveIndexEntryToDirectory(skillsDir, parsedEntry);
    if (!directory || seen.has(directory)) continue;

    seen.add(directory);
    directories.push(directory);
  }

  return directories;
}

function discoverSkillDirectories(skillsDir: string): string[] {
  if (!existsSync(skillsDir)) return [];

  const dirs: string[] = [];
  try {
    const entries = readdirSync(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const directoryPath = join(skillsDir, entry.name);
      if (existsSync(join(directoryPath, 'SKILL.md'))) {
        dirs.push(directoryPath);
      }
    }
  } catch (err) {
    log.warn({ err, skillsDir }, 'Failed to discover skill directories');
    return [];
  }

  return dirs.sort((a, b) => a.localeCompare(b));
}

export function loadSkillCatalog(): SkillSummary[] {
  const skillsDir = getSkillsDir();
  const indexedDirectories = getIndexedSkillDirectories(skillsDir);
  const directories = indexedDirectories ?? discoverSkillDirectories(skillsDir);

  const catalog: SkillSummary[] = [];
  const seenIds = new Set<string>();

  for (const directory of directories) {
    const skill = readSkillFromDirectory(directory, skillsDir);
    if (!skill) continue;

    if (seenIds.has(skill.id)) {
      log.warn({ id: skill.id, directory }, 'Skipping duplicate skill id');
      continue;
    }

    seenIds.add(skill.id);
    catalog.push({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      directoryPath: skill.directoryPath,
      skillFilePath: skill.skillFilePath,
    });
  }

  return catalog;
}

function loadSkillDefinition(skill: SkillSummary): SkillLookupResult {
  const loaded = readSkillFromDirectory(skill.directoryPath, getSkillsDir());
  if (!loaded) {
    return { error: `Failed to load SKILL.md for "${skill.id}"` };
  }
  return { skill: loaded };
}

export function resolveSkillSelector(selector: string): SkillSelectorResult {
  const needle = selector.trim();
  if (!needle) {
    return { error: 'Skill selector is required and must be a non-empty string.' };
  }

  const catalog = loadSkillCatalog();
  if (catalog.length === 0) {
    return { error: 'No skills are available. Configure ~/.vellum/skills/SKILLS.md or add skill directories.' };
  }

  const exactIdMatch = catalog.find((skill) => skill.id === needle);
  if (exactIdMatch) {
    return { skill: exactIdMatch };
  }

  const exactNameMatches = catalog.filter(
    (skill) => skill.name.toLowerCase() === needle.toLowerCase(),
  );
  if (exactNameMatches.length === 1) {
    return { skill: exactNameMatches[0] };
  }
  if (exactNameMatches.length > 1) {
    const ids = exactNameMatches.map((skill) => skill.id).join(', ');
    return { error: `Ambiguous skill name "${needle}". Matching IDs: ${ids}` };
  }

  const idPrefixMatches = catalog.filter((skill) => skill.id.startsWith(needle));
  if (idPrefixMatches.length === 1) {
    return { skill: idPrefixMatches[0] };
  }
  if (idPrefixMatches.length > 1) {
    const ids = idPrefixMatches.map((skill) => skill.id).join(', ');
    return { error: `Ambiguous skill id prefix "${needle}". Matching IDs: ${ids}` };
  }

  const knownSkills = catalog.map((skill) => skill.id).join(', ');
  return { error: `No skill matched "${needle}". Available skills: ${knownSkills}` };
}

export function loadSkillBySelector(selector: string): SkillLookupResult {
  const resolved = resolveSkillSelector(selector);
  if (!resolved.skill) {
    return { error: resolved.error ?? 'Failed to resolve skill selector.' };
  }
  return loadSkillDefinition(resolved.skill);
}

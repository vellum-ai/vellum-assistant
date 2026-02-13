import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { getConfig } from './loader.js';
import { getRootDir } from '../util/platform.js';
import { getLogger } from '../util/logger.js';

const log = getLogger('skills');

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

// ─── New interfaces for extended skill metadata ──────────────────────────────

export interface VellumMetadata {
  emoji?: string;
  os?: string[];
  requires?: SkillRequirements;
  primaryEnv?: string;
  install?: InstallerSpec[];
}

export interface SkillRequirements {
  bins?: string[];
  anyBins?: string[];
  env?: string[];
  config?: string[];
}

export interface InstallerSpec {
  id: string;
  kind: 'brew' | 'node' | 'go' | 'uv' | 'download';
  [key: string]: unknown;
}

export type SkillSource = 'bundled' | 'managed' | 'workspace' | 'extra';

// ─── Core interfaces ─────────────────────────────────────────────────────────

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  directoryPath: string;
  skillFilePath: string;
  bundled?: boolean;
  icon?: string;
  emoji?: string;
  homepage?: string;
  userInvocable: boolean;
  disableModelInvocation: boolean;
  source: SkillSource;
  metadata?: VellumMetadata;
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

// ─── Requirements check ──────────────────────────────────────────────────────

export interface RequirementsCheckResult {
  eligible: boolean;
  missing: {
    bins?: string[];
    env?: string[];
  };
}

export function checkSkillRequirements(
  skill: SkillSummary,
  envOverrides?: Record<string, string>,
): RequirementsCheckResult {
  const vellum = skill.metadata;
  if (!vellum) {
    return { eligible: true, missing: {} };
  }

  const missingBins: string[] = [];
  const missingEnv: string[] = [];

  // OS check
  if (vellum.os && vellum.os.length > 0) {
    if (!vellum.os.includes(process.platform)) {
      return {
        eligible: false,
        missing: {
          bins: [`(unsupported platform: ${process.platform}, requires: ${vellum.os.join(', ')})`],
        },
      };
    }
  }

  const requires = vellum.requires;
  if (!requires) {
    return { eligible: true, missing: {} };
  }

  // bins: all must exist
  if (requires.bins) {
    for (const bin of requires.bins) {
      if (!Bun.which(bin)) {
        missingBins.push(bin);
      }
    }
  }

  // anyBins: at least one must exist
  if (requires.anyBins && requires.anyBins.length > 0) {
    const hasAny = requires.anyBins.some((bin) => Bun.which(bin) !== null);
    if (!hasAny) {
      missingBins.push(`(one of: ${requires.anyBins.join(', ')})`);
    }
  }

  // env: check process.env or envOverrides
  if (requires.env) {
    const env = envOverrides ? { ...process.env, ...envOverrides } : process.env;
    for (const key of requires.env) {
      if (!env[key]) {
        missingEnv.push(key);
      }
    }
  }

  // config: skip for now (needs config integration from M2)

  const missing: RequirementsCheckResult['missing'] = {};
  if (missingBins.length > 0) missing.bins = missingBins;
  if (missingEnv.length > 0) missing.env = missingEnv;

  return {
    eligible: missingBins.length === 0 && missingEnv.length === 0,
    missing,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function getSkillsDir(): string {
  return join(getRootDir(), 'skills');
}

export function getBundledSkillsDir(): string {
  return join(import.meta.dir, 'bundled-skills');
}

function getSkillsIndexPath(skillsDir: string): string {
  return join(skillsDir, 'SKILLS.md');
}

// ─── Frontmatter parsing ─────────────────────────────────────────────────────

interface ParsedFrontmatter {
  name: string;
  description: string;
  body: string;
  homepage?: string;
  userInvocable: boolean;
  disableModelInvocation: boolean;
  metadata?: VellumMetadata;
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

  // Parse new optional fields
  const homepage = fields.homepage?.trim() || undefined;

  const userInvocableRaw = fields['user-invocable']?.trim().toLowerCase();
  const userInvocable = userInvocableRaw !== 'false';

  const disableModelInvocationRaw = fields['disable-model-invocation']?.trim().toLowerCase();
  const disableModelInvocation = disableModelInvocationRaw === 'true';

  // Parse metadata as single-line JSON string, extract .vellum namespace
  let metadata: VellumMetadata | undefined;
  const metadataRaw = fields.metadata?.trim();
  if (metadataRaw) {
    try {
      const parsed = JSON.parse(metadataRaw);
      if (parsed && typeof parsed === 'object' && parsed.vellum) {
        metadata = parsed.vellum as VellumMetadata;
      }
    } catch (err) {
      log.warn({ err, skillFilePath }, 'Failed to parse metadata JSON in frontmatter');
    }
  }

  return {
    name,
    description,
    body: content.slice(match[0].length).trim(),
    homepage,
    userInvocable,
    disableModelInvocation,
    metadata,
  };
}

// ─── Path utilities ──────────────────────────────────────────────────────────

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

// ─── Skill reading ───────────────────────────────────────────────────────────

function readSkillFromDirectory(directoryPath: string, skillsDir: string, source: SkillSource): SkillDefinition | null {
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
      emoji: parsed.metadata?.emoji,
      homepage: parsed.homepage,
      userInvocable: parsed.userInvocable,
      disableModelInvocation: parsed.disableModelInvocation,
      source,
      metadata: parsed.metadata,
    };
  } catch (err) {
    log.warn({ err, skillFilePath }, 'Failed to read skill file');
    return null;
  }
}

function readBundledSkillFromDirectory(directoryPath: string): SkillDefinition | null {
  const skillFilePath = join(directoryPath, 'SKILL.md');
  if (!existsSync(skillFilePath)) {
    log.warn({ directoryPath }, 'Skipping bundled skill directory without SKILL.md');
    return null;
  }

  try {
    const stat = statSync(skillFilePath);
    if (!stat.isFile()) {
      log.warn({ skillFilePath }, 'Skipping bundled skill path because SKILL.md is not a file');
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
      bundled: true,
      emoji: parsed.metadata?.emoji,
      homepage: parsed.homepage,
      userInvocable: parsed.userInvocable,
      disableModelInvocation: parsed.disableModelInvocation,
      source: 'bundled',
      metadata: parsed.metadata,
    };
  } catch (err) {
    log.warn({ err, skillFilePath }, 'Failed to read bundled skill file');
    return null;
  }
}

// ─── Skill discovery ─────────────────────────────────────────────────────────

function discoverBundledSkillDirectories(): string[] {
  const bundledDir = getBundledSkillsDir();
  if (!existsSync(bundledDir)) return [];

  const dirs: string[] = [];
  try {
    const entries = readdirSync(bundledDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const directoryPath = join(bundledDir, entry.name);
      if (existsSync(join(directoryPath, 'SKILL.md'))) {
        dirs.push(directoryPath);
      }
    }
  } catch (err) {
    log.warn({ err, bundledDir }, 'Failed to discover bundled skill directories');
    return [];
  }

  return dirs.sort((a, b) => a.localeCompare(b));
}

function loadBundledSkills(): SkillSummary[] {
  const directories = discoverBundledSkillDirectories();
  const skills: SkillSummary[] = [];

  for (const directory of directories) {
    const skill = readBundledSkillFromDirectory(directory);
    if (!skill) continue;

    skills.push({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      directoryPath: skill.directoryPath,
      skillFilePath: skill.skillFilePath,
      bundled: true,
      emoji: skill.emoji,
      homepage: skill.homepage,
      userInvocable: skill.userInvocable,
      disableModelInvocation: skill.disableModelInvocation,
      source: 'bundled',
      metadata: skill.metadata,
    });
  }

  return skills;
}

// ─── Index parsing ───────────────────────────────────────────────────────────

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

// ─── Catalog loading ─────────────────────────────────────────────────────────

function skillSummaryFromDefinition(skill: SkillDefinition, source: SkillSource): SkillSummary {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    directoryPath: skill.directoryPath,
    skillFilePath: skill.skillFilePath,
    bundled: skill.bundled,
    emoji: skill.emoji,
    homepage: skill.homepage,
    userInvocable: skill.userInvocable,
    disableModelInvocation: skill.disableModelInvocation,
    source,
    metadata: skill.metadata,
  };
}

export function loadSkillCatalog(workspaceSkillsDir?: string, extraDirs?: string[]): SkillSummary[] {
  const catalog: SkillSummary[] = [];
  const seenIds = new Set<string>();

  // Load extra directories first (lowest precedence, before bundled)
  if (extraDirs) {
    for (const dir of extraDirs) {
      if (!existsSync(dir)) continue;
      const dirs = discoverSkillDirectories(dir);
      for (const directory of dirs) {
        const skillFilePath = join(directory, 'SKILL.md');
        if (!existsSync(skillFilePath)) continue;

        try {
          const stat = statSync(skillFilePath);
          if (!stat.isFile()) continue;

          const content = readFileSync(skillFilePath, 'utf-8');
          const parsed = parseFrontmatter(content, skillFilePath);
          if (!parsed) continue;

          const id = basename(directory);
          if (seenIds.has(id)) {
            log.warn({ id, directory }, 'Skipping duplicate skill id from extraDirs');
            continue;
          }

          seenIds.add(id);
          catalog.push({
            id,
            name: parsed.name,
            description: parsed.description,
            directoryPath: directory,
            skillFilePath,
            emoji: parsed.metadata?.emoji,
            homepage: parsed.homepage,
            userInvocable: parsed.userInvocable,
            disableModelInvocation: parsed.disableModelInvocation,
            source: 'extra',
            metadata: parsed.metadata,
          });
        } catch (err) {
          log.warn({ err, directory }, 'Failed to read skill from extraDirs');
        }
      }
    }
  }

  // Load bundled skills (override extraDirs skills with same ID)
  const bundledSkills = loadBundledSkills();
  for (const skill of bundledSkills) {
    if (seenIds.has(skill.id)) {
      // Bundled wins over extraDirs
      const existingIndex = catalog.findIndex((s) => s.id === skill.id);
      if (existingIndex !== -1 && catalog[existingIndex].source === 'extra') {
        log.info({ id: skill.id, directory: skill.directoryPath }, 'Bundled skill overrides extraDirs skill');
        catalog[existingIndex] = skill;
        continue;
      }
      log.warn({ id: skill.id, directory: skill.directoryPath }, 'Skipping duplicate bundled skill id');
      continue;
    }
    seenIds.add(skill.id);
    catalog.push(skill);
  }

  // Load managed (user) skills, which take precedence over bundled skills with the same ID
  const skillsDir = getSkillsDir();
  const indexedDirectories = getIndexedSkillDirectories(skillsDir);
  const directories = indexedDirectories ?? discoverSkillDirectories(skillsDir);

  for (const directory of directories) {
    const skill = readSkillFromDirectory(directory, skillsDir, 'managed');
    if (!skill) continue;

    if (seenIds.has(skill.id)) {
      // If the existing entry is bundled, the user skill overrides it
      const existingIndex = catalog.findIndex((s) => s.id === skill.id);
      if (existingIndex !== -1 && (catalog[existingIndex].bundled || catalog[existingIndex].source === 'extra')) {
        log.info({ id: skill.id, directory }, 'User skill overrides bundled skill');
        catalog[existingIndex] = skillSummaryFromDefinition(skill, 'managed');
        continue;
      }
      log.warn({ id: skill.id, directory }, 'Skipping duplicate skill id');
      continue;
    }

    seenIds.add(skill.id);
    catalog.push(skillSummaryFromDefinition(skill, 'managed'));
  }

  // Load workspace skills with highest precedence
  if (workspaceSkillsDir && existsSync(workspaceSkillsDir)) {
    const workspaceDirs = discoverSkillDirectories(workspaceSkillsDir);

    for (const directory of workspaceDirs) {
      const skillFilePath = join(directory, 'SKILL.md');
      if (!existsSync(skillFilePath)) continue;

      try {
        const stat = statSync(skillFilePath);
        if (!stat.isFile()) continue;

        const content = readFileSync(skillFilePath, 'utf-8');
        const parsed = parseFrontmatter(content, skillFilePath);
        if (!parsed) continue;

        const id = basename(directory);
        const workspaceSkill: SkillSummary = {
          id,
          name: parsed.name,
          description: parsed.description,
          directoryPath: directory,
          skillFilePath,
          emoji: parsed.metadata?.emoji,
          homepage: parsed.homepage,
          userInvocable: parsed.userInvocable,
          disableModelInvocation: parsed.disableModelInvocation,
          source: 'workspace',
          metadata: parsed.metadata,
        };

        if (seenIds.has(id)) {
          // Workspace skills override any existing skill
          const existingIndex = catalog.findIndex((s) => s.id === id);
          if (existingIndex !== -1) {
            log.info({ id, directory }, 'Workspace skill overrides existing skill');
            catalog[existingIndex] = workspaceSkill;
            continue;
          }
        }

        seenIds.add(id);
        catalog.push(workspaceSkill);
      } catch (err) {
        log.warn({ err, directory }, 'Failed to read workspace skill');
      }
    }
  }

  return catalog;
}

function loadSkillDefinition(skill: SkillSummary): SkillLookupResult {
  let loaded: SkillDefinition | null;
  if (skill.bundled) {
    loaded = readBundledSkillFromDirectory(skill.directoryPath);
  } else if (skill.source === 'workspace') {
    // Workspace skills live outside ~/.vellum/skills, so use their parent
    // directory as the root to avoid the isOutsideSkillsRoot rejection.
    loaded = readSkillFromDirectory(skill.directoryPath, dirname(skill.directoryPath), skill.source);
  } else {
    loaded = readSkillFromDirectory(skill.directoryPath, getSkillsDir(), skill.source);
  }
  if (!loaded) {
    return { error: `Failed to load SKILL.md for "${skill.id}"` };
  }
  // Replace {baseDir} placeholders with the actual skill directory path
  loaded.body = loaded.body.replaceAll('{baseDir}', loaded.directoryPath);
  return { skill: loaded };
}

export function resolveSkillSelector(selector: string, workspaceSkillsDir?: string): SkillSelectorResult {
  const needle = selector.trim();
  if (!needle) {
    return { error: 'Skill selector is required and must be a non-empty string.' };
  }

  const catalog = loadSkillCatalog(workspaceSkillsDir);
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

export function loadSkillBySelector(selector: string, workspaceSkillsDir?: string): SkillLookupResult {
  const resolved = resolveSkillSelector(selector, workspaceSkillsDir);
  if (!resolved.skill) {
    return { error: resolved.error ?? 'Failed to resolve skill selector.' };
  }
  return loadSkillDefinition(resolved.skill);
}

// ─── Icon generation ─────────────────────────────────────────────────────────

async function generateSkillIcon(name: string, description: string): Promise<string> {
  const config = getConfig();
  const apiKey = config.apiKeys.anthropic ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('No Anthropic API key available for icon generation');
  }

  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: 'You are a pixel art icon designer. When asked, return ONLY a single <svg> element — no explanation, no markdown, no code fences. The SVG must be a 16x16 grid pixel art icon using <rect> elements. Use a limited palette (3-5 colors). Keep it under 2KB. The viewBox should be "0 0 16 16" with each pixel being a 1x1 rect.',
    messages: [{
      role: 'user',
      content: `Create a 16x16 pixel art SVG icon representing this skill:\nName: ${name}\nDescription: ${description}`,
    }],
  });

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  const svgMatch = text.match(/<svg[\s\S]*<\/svg>/i);
  if (!svgMatch) {
    throw new Error('No <svg> element found in response');
  }

  return svgMatch[0];
}

/**
 * Synchronously read a cached icon if it exists on disk. Returns undefined if not cached yet.
 */
export function readCachedSkillIcon(directoryPath: string): string | undefined {
  const iconPath = join(directoryPath, 'icon.svg');
  if (existsSync(iconPath)) {
    try {
      return readFileSync(iconPath, 'utf-8');
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export async function ensureSkillIcon(directoryPath: string, name: string, description: string): Promise<string | undefined> {
  const iconPath = join(directoryPath, 'icon.svg');

  if (existsSync(iconPath)) {
    try {
      return readFileSync(iconPath, 'utf-8');
    } catch {
      log.warn({ iconPath }, 'Failed to read existing icon.svg');
      return undefined;
    }
  }

  try {
    const svg = await generateSkillIcon(name, description);
    try {
      writeFileSync(iconPath, svg, 'utf-8');
      log.info({ iconPath }, 'Generated skill icon');
    } catch (writeErr) {
      log.warn({ err: writeErr, iconPath }, 'Failed to cache icon.svg (returning generated icon anyway)');
    }
    return svg;
  } catch (err) {
    log.warn({ err, iconPath }, 'Failed to generate skill icon');
    return undefined;
  }
}

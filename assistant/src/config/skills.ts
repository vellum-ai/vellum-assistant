import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

import { z } from "zod";

import { stripCommentLines } from "../prompts/system-prompt.js";
import {
  extractAllText,
  getConfiguredProvider,
  userMessage,
} from "../providers/provider-send-message.js";
import { parseFrontmatterFields } from "../skills/frontmatter.js";
import { parseToolManifestFile } from "../skills/tool-manifest.js";
import { computeSkillVersionHash } from "../skills/version-hash.js";
import { getLogger } from "../util/logger.js";
import { getWorkspaceSkillsDir } from "../util/platform.js";
import { isAssistantFeatureFlagEnabled } from "./assistant-feature-flags.js";
import { getConfig } from "./loader.js";

const log = getLogger("skills");

// ─── Zod schemas for frontmatter metadata validation ─────────────────────────

const VellumMetadataSchema = z
  .object({
    emoji: z.string().optional(),
    requires: z
      .object({
        bins: z.array(z.string()).optional(),
        anyBins: z.array(z.string()).optional(),
        env: z.array(z.string()).optional(),
        config: z.array(z.string()).optional(),
      })
      .optional(),
    primaryEnv: z.string().optional(),
    install: z
      .array(
        z
          .object({
            id: z.string(),
            kind: z.enum(["brew", "node", "go", "uv", "download"]),
          })
          .passthrough(),
      )
      .optional(),
    cli: z
      .object({
        command: z.string(),
        entry: z.string(),
      })
      .optional(),
    "display-name": z.string().optional(),
    "user-invocable": z.union([z.boolean(), z.string()]).optional(),
    "disable-model-invocation": z.union([z.boolean(), z.string()]).optional(),
    includes: z.array(z.string()).optional(),
    "credential-setup-for": z.string().optional(),
    "feature-flag": z.string().optional(),
  })
  .passthrough();

const SkillMetadataSchema = z
  .object({
    emoji: z.string().optional(),
    vellum: VellumMetadataSchema.optional(),
  })
  .passthrough();

// ─── New interfaces for extended skill metadata ──────────────────────────────

export interface SkillCliSpec {
  /** CLI command name (e.g. "doordash"). Used as the launcher script name in ~/.vellum/bin/. */
  command: string;
  /** Entry point filename relative to the skill directory (e.g. "doordash-entry.ts"). */
  entry: string;
}

export interface VellumMetadata {
  emoji?: string;
  requires?: SkillRequirements;
  primaryEnv?: string;
  install?: InstallerSpec[];
  /** Declares a standalone CLI entry point for this skill. */
  cli?: SkillCliSpec;
}

export interface SkillRequirements {
  bins?: string[];
  anyBins?: string[];
  env?: string[];
  config?: string[];
}

export interface InstallerSpec {
  id: string;
  kind: "brew" | "node" | "go" | "uv" | "download";
  [key: string]: unknown;
}

export type SkillSource = "bundled" | "managed" | "workspace" | "extra";

// ─── Core interfaces ─────────────────────────────────────────────────────────

export interface SkillSummary {
  id: string;
  name: string;
  displayName: string;
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
  /** Parsed tool manifest metadata, if the skill has a valid TOOLS.json. */
  toolManifest?: SkillToolManifestMeta;
  /** IDs of child skills that this skill includes (metadata-only, not auto-activated). */
  includes?: string[];
  /** Declares which credential this skill sets up (e.g. "vercel:api_token"). */
  credentialSetupFor?: string;
  /** Feature flag ID declared in frontmatter. Only skills with this field are subject to feature flag gating. */
  featureFlag?: string;
}

export interface SkillDefinition extends SkillSummary {
  body: string;
}

export type SkillLookupErrorCode =
  | "not_found"
  | "ambiguous"
  | "empty_catalog"
  | "invalid_selector"
  | "load_failed";

export interface SkillLookupResult {
  skill?: SkillDefinition;
  error?: string;
  errorCode?: SkillLookupErrorCode;
}

export interface SkillSelectorResult {
  skill?: SkillSummary;
  error?: string;
  errorCode?: SkillLookupErrorCode;
}

// ─── Skill Tool Manifest Types ────────────────────────────────────────────────

/**
 * Schema for a skill's TOOLS.json manifest file.
 * Declares which tools a skill provides and how they should be executed.
 */
export interface SkillToolManifest {
  version: 1;
  tools: SkillToolEntry[];
}

/**
 * A single tool entry within a skill's TOOLS.json manifest.
 */
export interface SkillToolEntry {
  /** Unique tool name (must not collide with core tool names). */
  name: string;
  /** Human-readable description shown to the model. */
  description: string;
  /** Tool category for grouping/display. */
  category: string;
  /** Default risk level for permission checks. */
  risk: "low" | "medium" | "high";
  /** JSON Schema for the tool's input parameters. */
  input_schema: Record<string, unknown>;
  /** Relative path to the executor script within the skill directory. */
  executor: string;
  /** Where the tool script runs. */
  execution_target: "host" | "sandbox";
}

/**
 * Lightweight metadata about a skill's tool manifest, attached to SkillSummary
 * without loading the full manifest at catalog time.
 */
export interface SkillToolManifestMeta {
  /** Whether the skill has a TOOLS.json file. */
  present: boolean;
  /** Whether the manifest parsed successfully. */
  valid: boolean;
  /** Number of tools declared in the manifest (0 if invalid). */
  toolCount: number;
  /** Tool names declared in the manifest (empty if invalid). */
  toolNames: string[];
  /**
   * Deterministic content hash of the skill directory (`v1:<hex-sha256>`).
   * Lazily computed on first access to avoid hashing every skill directory
   * during catalog load.
   */
  versionHash?: string;
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
    const hasAny = requires.anyBins.some((bin) => Bun.which(bin) != null);
    if (!hasAny) {
      missingBins.push(`(one of: ${requires.anyBins.join(", ")})`);
    }
  }

  // env: check process.env or envOverrides
  if (requires.env) {
    const env = envOverrides
      ? { ...process.env, ...envOverrides }
      : process.env;
    for (const key of requires.env) {
      if (!env[key]) {
        missingEnv.push(key);
      }
    }
  }

  // config: skip for now (needs config integration from M2)

  const missing: RequirementsCheckResult["missing"] = {};
  if (missingBins.length > 0) missing.bins = missingBins;
  if (missingEnv.length > 0) missing.env = missingEnv;

  return {
    eligible: missingBins.length === 0 && missingEnv.length === 0,
    missing,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function getSkillsDir(): string {
  return getWorkspaceSkillsDir();
}

export function getBundledSkillsDir(): string {
  const dir = import.meta.dir;

  // In compiled Bun binaries, import.meta.dir points into the virtual
  // /$bunfs/ filesystem where non-JS assets don't exist.  Fall back to
  // the macOS .app bundle Resources dir or next to the binary.
  if (dir.startsWith("/$bunfs/")) {
    const execDir = dirname(process.execPath);
    // macOS .app bundle: binary is in Contents/MacOS/, resources in Contents/Resources/
    const resourcesPath = join(execDir, "..", "Resources", "bundled-skills");
    if (existsSync(resourcesPath)) return resourcesPath;
    // Next to the binary itself (non-app-bundle deployments)
    const execDirPath = join(execDir, "bundled-skills");
    if (existsSync(execDirPath)) return execDirPath;
  }

  return join(dir, "bundled-skills");
}

function getSkillsIndexPath(skillsDir: string): string {
  return join(skillsDir, "SKILLS.md");
}

// ─── Frontmatter parsing ─────────────────────────────────────────────────────

interface ParsedFrontmatter {
  name: string;
  displayName: string;
  description: string;
  body: string;
  userInvocable: boolean;
  disableModelInvocation: boolean;
  metadata?: VellumMetadata;
  includes?: string[];
  credentialSetupFor?: string;
  featureFlag?: string;
}

function parseFrontmatter(
  content: string,
  skillFilePath: string,
): ParsedFrontmatter | null {
  const result = parseFrontmatterFields(content);
  if (!result) {
    log.warn({ skillFilePath }, "Skipping skill without YAML frontmatter");
    return null;
  }

  const { fields, body } = result;

  const name = typeof fields.name === "string" ? fields.name.trim() : undefined;
  const description =
    typeof fields.description === "string"
      ? fields.description.trim()
      : undefined;
  if (!name || !description) {
    log.warn(
      { skillFilePath },
      'Skipping skill missing required frontmatter keys "name" and/or "description"',
    );
    return null;
  }

  // metadata is already a parsed object from YAML — validate with Zod schema
  let metadata: VellumMetadata | undefined;
  let parsedMeta: z.infer<typeof SkillMetadataSchema> | undefined;
  let vellum: z.infer<typeof VellumMetadataSchema> | undefined;

  const metadataRaw = fields.metadata;
  if (metadataRaw != null) {
    if (typeof metadataRaw === "string") {
      // metadata is a string — this means someone wrote inline JSON or a
      // bare string value. YAML metadata must be a nested object.
      log.warn(
        { skillFilePath },
        "Metadata must be a YAML object, not a string; ignoring metadata field",
      );
    } else if (typeof metadataRaw === "object") {
      const zodResult = SkillMetadataSchema.safeParse(metadataRaw);
      if (zodResult.success) {
        parsedMeta = zodResult.data;
        vellum = parsedMeta.vellum;
        if (parsedMeta.vellum) {
          metadata = parsedMeta.vellum as VellumMetadata;
        }
        // Inject top-level emoji into metadata when metadata.vellum doesn't
        // carry its own emoji. The Agent Skills spec places emoji at the
        // top level of the metadata object, so bundled skills that follow
        // this convention would otherwise lose their emoji value.
        if (parsedMeta.emoji) {
          if (metadata && !metadata.emoji) {
            metadata.emoji = parsedMeta.emoji;
          } else if (!metadata) {
            metadata = { emoji: parsedMeta.emoji };
          }
        }
      } else {
        // Zod validation failed — fall back to raw parsed object so we don't
        // lose all metadata because of a single bad field value.  We coerce
        // critical array fields so downstream code that iterates them
        // (e.g. `.join()`, `for...of`, `.some()`) won't crash.
        log.warn(
          { err: zodResult.error, skillFilePath },
          "Metadata failed schema validation; falling back to raw object",
        );
        const raw = metadataRaw as Record<string, unknown>;
        parsedMeta = raw as z.infer<typeof SkillMetadataSchema>;
        vellum = raw?.vellum as z.infer<typeof VellumMetadataSchema>;
        if (raw?.vellum && typeof raw.vellum === "object") {
          const vellumRaw = raw.vellum as Record<string, unknown>;

          // Coerce `requires` sub-fields to arrays.
          if (vellumRaw.requires && typeof vellumRaw.requires === "object") {
            const req = vellumRaw.requires as Record<string, unknown>;
            for (const key of ["bins", "anyBins", "env", "config"] as const) {
              if (req[key] !== undefined && !Array.isArray(req[key])) {
                req[key] = typeof req[key] === "string" ? [req[key]] : [];
              }
            }
          }

          metadata = vellumRaw as unknown as VellumMetadata;
        }
      }
    }
  }

  // Read vellum-specific fields exclusively from metadata.vellum
  const vellumUserInvocable = vellum?.["user-invocable"];
  let userInvocable: boolean;
  if (typeof vellumUserInvocable === "boolean") {
    userInvocable = vellumUserInvocable;
  } else if (typeof vellumUserInvocable === "string") {
    userInvocable = vellumUserInvocable !== "false";
  } else {
    userInvocable = true;
  }

  const vellumDisableModelInvocation = vellum?.["disable-model-invocation"];
  let disableModelInvocation: boolean;
  if (typeof vellumDisableModelInvocation === "boolean") {
    disableModelInvocation = vellumDisableModelInvocation;
  } else if (typeof vellumDisableModelInvocation === "string") {
    disableModelInvocation = vellumDisableModelInvocation === "true";
  } else {
    disableModelInvocation = false;
  }

  let includes: string[] | undefined;
  if (Array.isArray(vellum?.includes)) {
    const normalized = [
      ...new Set(
        vellum.includes
          .filter((item: unknown): item is string => typeof item === "string")
          .map((s: string) => s.trim())
          .filter((s: string) => s.length > 0),
      ),
    ];
    includes = normalized.length > 0 ? normalized : undefined;
  }

  const credentialSetupFor =
    typeof vellum?.["credential-setup-for"] === "string"
      ? vellum["credential-setup-for"]
      : undefined;

  const featureFlag =
    typeof vellum?.["feature-flag"] === "string"
      ? vellum["feature-flag"]
      : undefined;

  const displayName =
    (typeof vellum?.["display-name"] === "string"
      ? vellum["display-name"]
      : undefined) ?? name;

  return {
    name,
    displayName,
    description,
    body: stripCommentLines(body),
    userInvocable,
    disableModelInvocation,
    metadata,
    includes,
    credentialSetupFor,
    featureFlag,
  };
}

// ─── Path utilities ──────────────────────────────────────────────────────────

function getCanonicalPath(path: string): string {
  return existsSync(path) ? realpathSync(path) : resolve(path);
}

function getRelativeToSkillsRoot(
  skillsDir: string,
  candidatePath: string,
): string {
  return relative(getCanonicalPath(skillsDir), getCanonicalPath(candidatePath));
}

function isOutsideSkillsRoot(
  skillsDir: string,
  candidatePath: string,
): boolean {
  const relativePath = getRelativeToSkillsRoot(skillsDir, candidatePath);
  return relativePath.startsWith("..") || isAbsolute(relativePath);
}

// ─── Tool manifest detection ─────────────────────────────────────────────────

/**
 * Create a SkillToolManifestMeta with a lazily-computed versionHash.
 * The hash is only computed when first accessed, avoiding the cost of
 * recursively hashing the skill directory during catalog load.
 */
function createManifestMeta(
  base: Omit<SkillToolManifestMeta, "versionHash">,
  directoryPath: string,
): SkillToolManifestMeta {
  let cached: string | undefined;
  let computed = false;
  return Object.defineProperty({ ...base }, "versionHash", {
    get() {
      if (!computed) {
        computed = true;
        try {
          cached = computeSkillVersionHash(directoryPath);
        } catch (err) {
          log.warn(
            { err, directoryPath },
            "Failed to compute skill version hash",
          );
        }
      }
      return cached;
    },
    enumerable: true,
    configurable: true,
  });
}

/**
 * Detect and parse a TOOLS.json manifest in a skill directory.
 * Returns the manifest metadata if the file exists, or undefined if it doesn't.
 * On parse failure, returns a degraded metadata object (present but invalid).
 */
function detectToolManifest(
  directoryPath: string,
): SkillToolManifestMeta | undefined {
  const manifestPath = join(directoryPath, "TOOLS.json");
  if (!existsSync(manifestPath)) {
    return undefined;
  }

  try {
    const manifest = parseToolManifestFile(manifestPath);
    return createManifestMeta(
      {
        present: true,
        valid: true,
        toolCount: manifest.tools.length,
        toolNames: manifest.tools.map((t) => t.name),
      },
      directoryPath,
    );
  } catch (err) {
    log.warn({ err, manifestPath }, "Failed to parse TOOLS.json manifest");
    return createManifestMeta(
      {
        present: true,
        valid: false,
        toolCount: 0,
        toolNames: [],
      },
      directoryPath,
    );
  }
}

// ─── Skill reading ───────────────────────────────────────────────────────────

function readSkillFromDirectory(
  directoryPath: string,
  skillsDir: string,
  source: SkillSource,
): SkillDefinition | null {
  const skillFilePath = join(directoryPath, "SKILL.md");
  if (!existsSync(skillFilePath)) {
    log.warn({ directoryPath }, "Skipping skill directory without SKILL.md");
    return null;
  }

  try {
    if (isOutsideSkillsRoot(skillsDir, directoryPath)) {
      log.warn(
        { directoryPath },
        "Skipping skill directory that resolves outside ~/.vellum/workspace/skills",
      );
      return null;
    }

    const stat = statSync(skillFilePath);
    if (!stat.isFile()) {
      log.warn(
        { skillFilePath },
        "Skipping skill path because SKILL.md is not a file",
      );
      return null;
    }

    if (isOutsideSkillsRoot(skillsDir, skillFilePath)) {
      log.warn(
        { skillFilePath },
        "Skipping SKILL.md that resolves outside ~/.vellum/workspace/skills",
      );
      return null;
    }

    const content = readFileSync(skillFilePath, "utf-8");
    const parsed = parseFrontmatter(content, skillFilePath);
    if (!parsed) return null;

    return {
      id: basename(directoryPath),
      name: parsed.name,
      displayName: parsed.displayName,
      description: parsed.description,
      directoryPath,
      skillFilePath,
      body: parsed.body,
      emoji: parsed.metadata?.emoji,
      userInvocable: parsed.userInvocable,
      disableModelInvocation: parsed.disableModelInvocation,
      source,
      metadata: parsed.metadata,
      toolManifest: detectToolManifest(directoryPath),
      includes: parsed.includes,
      credentialSetupFor: parsed.credentialSetupFor,
      featureFlag: parsed.featureFlag,
    };
  } catch (err) {
    log.warn({ err, skillFilePath }, "Failed to read skill file");
    return null;
  }
}

function readBundledSkillFromDirectory(
  directoryPath: string,
): SkillDefinition | null {
  const skillFilePath = join(directoryPath, "SKILL.md");
  if (!existsSync(skillFilePath)) {
    log.warn(
      { directoryPath },
      "Skipping bundled skill directory without SKILL.md",
    );
    return null;
  }

  try {
    const stat = statSync(skillFilePath);
    if (!stat.isFile()) {
      log.warn(
        { skillFilePath },
        "Skipping bundled skill path because SKILL.md is not a file",
      );
      return null;
    }

    const content = readFileSync(skillFilePath, "utf-8");
    const parsed = parseFrontmatter(content, skillFilePath);
    if (!parsed) return null;

    return {
      id: basename(directoryPath),
      name: parsed.name,
      displayName: parsed.displayName,
      description: parsed.description,
      directoryPath,
      skillFilePath,
      body: parsed.body,
      bundled: true,
      emoji: parsed.metadata?.emoji,
      userInvocable: parsed.userInvocable,
      disableModelInvocation: parsed.disableModelInvocation,
      source: "bundled",
      metadata: parsed.metadata,
      toolManifest: detectToolManifest(directoryPath),
      includes: parsed.includes,
      credentialSetupFor: parsed.credentialSetupFor,
      featureFlag: parsed.featureFlag,
    };
  } catch (err) {
    log.warn({ err, skillFilePath }, "Failed to read bundled skill file");
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
      if (existsSync(join(directoryPath, "SKILL.md"))) {
        dirs.push(directoryPath);
      }
    }
  } catch (err) {
    log.warn(
      { err, bundledDir },
      "Failed to discover bundled skill directories",
    );
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
      displayName: skill.displayName,
      description: skill.description,
      directoryPath: skill.directoryPath,
      skillFilePath: skill.skillFilePath,
      bundled: true,
      emoji: skill.emoji,
      userInvocable: skill.userInvocable,
      disableModelInvocation: skill.disableModelInvocation,
      source: "bundled",
      metadata: skill.metadata,
      toolManifest: skill.toolManifest,
      includes: skill.includes,
      credentialSetupFor: skill.credentialSetupFor,
      featureFlag: skill.featureFlag,
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

  if (entry.startsWith("`") && entry.endsWith("`")) {
    entry = entry.slice(1, -1).trim();
  }

  return entry.length > 0 ? entry : null;
}

function resolveIndexEntryToDirectory(
  skillsDir: string,
  entry: string,
): string | null {
  if (isAbsolute(entry)) {
    log.warn(
      { entry },
      "Skipping SKILLS.md entry because absolute paths are not allowed",
    );
    return null;
  }

  const resolvedEntryPath = resolve(skillsDir, entry);
  const resolvedDirectory =
    basename(resolvedEntryPath).toLowerCase() === "skill.md"
      ? dirname(resolvedEntryPath)
      : resolvedEntryPath;

  const relativePath = getRelativeToSkillsRoot(skillsDir, resolvedDirectory);
  if (relativePath.length === 0) {
    log.warn(
      { entry },
      "Skipping SKILLS.md entry that resolves to the skills root",
    );
    return null;
  }
  if (isOutsideSkillsRoot(skillsDir, resolvedDirectory)) {
    log.warn(
      { entry, resolvedDirectory: getCanonicalPath(resolvedDirectory) },
      "Skipping SKILLS.md entry that resolves outside ~/.vellum/workspace/skills",
    );
    return null;
  }

  return resolvedDirectory;
}

function getIndexedSkillDirectories(skillsDir: string): string[] | null {
  const indexPath = getSkillsIndexPath(skillsDir);
  if (!existsSync(indexPath)) return null;

  let rawIndex = "";
  try {
    rawIndex = readFileSync(indexPath, "utf-8");
  } catch (err) {
    log.warn(
      { err, indexPath },
      "Failed to read SKILLS.md; treating as empty catalog",
    );
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
      if (existsSync(join(directoryPath, "SKILL.md"))) {
        dirs.push(directoryPath);
      }
    }
  } catch (err) {
    log.warn({ err, skillsDir }, "Failed to discover skill directories");
    return [];
  }

  return dirs.sort((a, b) => a.localeCompare(b));
}

// ─── Catalog loading ─────────────────────────────────────────────────────────

function skillSummaryFromDefinition(
  skill: SkillDefinition,
  source: SkillSource,
): SkillSummary {
  return {
    id: skill.id,
    name: skill.name,
    displayName: skill.displayName,
    description: skill.description,
    directoryPath: skill.directoryPath,
    skillFilePath: skill.skillFilePath,
    bundled: skill.bundled,
    emoji: skill.emoji,
    userInvocable: skill.userInvocable,
    disableModelInvocation: skill.disableModelInvocation,
    source,
    metadata: skill.metadata,
    toolManifest: skill.toolManifest,
    includes: skill.includes,
    credentialSetupFor: skill.credentialSetupFor,
    featureFlag: skill.featureFlag,
  };
}

export function loadSkillCatalog(
  workspaceSkillsDir?: string,
  extraDirs?: string[],
): SkillSummary[] {
  const catalog: SkillSummary[] = [];
  const seenIds = new Set<string>();

  // Load extra directories first (lowest precedence, before bundled)
  if (extraDirs) {
    for (const dir of extraDirs) {
      if (!existsSync(dir)) continue;
      const dirs = discoverSkillDirectories(dir);
      for (const directory of dirs) {
        const skillFilePath = join(directory, "SKILL.md");
        if (!existsSync(skillFilePath)) continue;

        try {
          const stat = statSync(skillFilePath);
          if (!stat.isFile()) continue;

          const content = readFileSync(skillFilePath, "utf-8");
          const parsed = parseFrontmatter(content, skillFilePath);
          if (!parsed) continue;

          const id = basename(directory);
          if (seenIds.has(id)) {
            log.warn(
              { id, directory },
              "Skipping duplicate skill id from extraDirs",
            );
            continue;
          }

          seenIds.add(id);
          catalog.push({
            id,
            name: parsed.name,
            displayName: parsed.displayName ?? parsed.name,
            description: parsed.description,
            directoryPath: directory,
            skillFilePath,
            emoji: parsed.metadata?.emoji,
            userInvocable: parsed.userInvocable,
            disableModelInvocation: parsed.disableModelInvocation,
            source: "extra",
            metadata: parsed.metadata,
            toolManifest: detectToolManifest(directory),
            includes: parsed.includes,
            credentialSetupFor: parsed.credentialSetupFor,
            featureFlag: parsed.featureFlag,
          });
        } catch (err) {
          log.warn({ err, directory }, "Failed to read skill from extraDirs");
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
      if (existingIndex !== -1 && catalog[existingIndex].source === "extra") {
        log.info(
          { id: skill.id, directory: skill.directoryPath },
          "Bundled skill overrides extraDirs skill",
        );
        catalog[existingIndex] = skill;
        continue;
      }
      log.warn(
        { id: skill.id, directory: skill.directoryPath },
        "Skipping duplicate bundled skill id",
      );
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
    const skill = readSkillFromDirectory(directory, skillsDir, "managed");
    if (!skill) continue;

    if (seenIds.has(skill.id)) {
      // If the existing entry is bundled, the user skill overrides it
      const existingIndex = catalog.findIndex((s) => s.id === skill.id);
      if (
        existingIndex !== -1 &&
        (catalog[existingIndex].bundled ||
          catalog[existingIndex].source === "extra")
      ) {
        log.info(
          { id: skill.id, directory },
          "User skill overrides bundled skill",
        );
        catalog[existingIndex] = skillSummaryFromDefinition(skill, "managed");
        continue;
      }
      log.warn({ id: skill.id, directory }, "Skipping duplicate skill id");
      continue;
    }

    seenIds.add(skill.id);
    catalog.push(skillSummaryFromDefinition(skill, "managed"));
  }

  // Load workspace skills with highest precedence
  if (workspaceSkillsDir && existsSync(workspaceSkillsDir)) {
    const workspaceDirs = discoverSkillDirectories(workspaceSkillsDir);

    for (const directory of workspaceDirs) {
      const skillFilePath = join(directory, "SKILL.md");
      if (!existsSync(skillFilePath)) continue;

      try {
        const stat = statSync(skillFilePath);
        if (!stat.isFile()) continue;

        const content = readFileSync(skillFilePath, "utf-8");
        const parsed = parseFrontmatter(content, skillFilePath);
        if (!parsed) continue;

        const id = basename(directory);
        const workspaceSkill: SkillSummary = {
          id,
          name: parsed.name,
          displayName: parsed.displayName ?? parsed.name,
          description: parsed.description,
          directoryPath: directory,
          skillFilePath,
          emoji: parsed.metadata?.emoji,
          userInvocable: parsed.userInvocable,
          disableModelInvocation: parsed.disableModelInvocation,
          source: "workspace",
          metadata: parsed.metadata,
          toolManifest: detectToolManifest(directory),
          includes: parsed.includes,
          credentialSetupFor: parsed.credentialSetupFor,
          featureFlag: parsed.featureFlag,
        };

        if (seenIds.has(id)) {
          // Workspace skills override any existing skill
          const existingIndex = catalog.findIndex((s) => s.id === id);
          if (existingIndex !== -1) {
            log.info(
              { id, directory },
              "Workspace skill overrides existing skill",
            );
            catalog[existingIndex] = workspaceSkill;
            continue;
          }
        }

        seenIds.add(id);
        catalog.push(workspaceSkill);
      } catch (err) {
        log.warn({ err, directory }, "Failed to read workspace skill");
      }
    }
  }

  return catalog;
}

/**
 * Process feature-gated sections in skill body markdown.
 *
 * Markers:
 *   <!-- feature:<flag-id>:start --> ... <!-- feature:<flag-id>:end -->
 *     Content included only when the flag is enabled.
 *   <!-- feature:<flag-id>:alt --> ... <!-- feature:<flag-id>:alt:end -->
 *     Fallback content included only when the flag is disabled.
 */
function applyFeatureGatedSections(body: string): string {
  const config = getConfig();
  // Match feature:*:start/end blocks
  const mainRe =
    /<!-- feature:([^:]+):start -->\n?([\s\S]*?)<!-- feature:\1:end -->\n?/g;
  // Match feature:*:alt/alt:end blocks
  const altRe =
    /<!-- feature:([^:]+):alt -->\n?([\s\S]*?)<!-- feature:\1:alt:end -->\n?/g;

  let result = body;

  result = result.replace(mainRe, (_match, flagId: string, content: string) => {
    const key = `feature_flags.${flagId}.enabled`;
    return isAssistantFeatureFlagEnabled(key, config) ? content : "";
  });

  result = result.replace(altRe, (_match, flagId: string, content: string) => {
    const key = `feature_flags.${flagId}.enabled`;
    return isAssistantFeatureFlagEnabled(key, config) ? "" : content;
  });

  return result;
}

/**
 * Returns true if `filePath` is a symlink whose resolved real path escapes
 * `rootDir`. Symlinks that stay within `rootDir` are allowed; only those that
 * point outside are considered unsafe.
 */
function isEscapingSymlink(filePath: string, rootDir: string): boolean {
  try {
    if (!lstatSync(filePath).isSymbolicLink()) return false;
    const real = realpathSync(filePath);
    const normalizedRoot = getCanonicalPath(rootDir);
    return (
      real !== normalizedRoot &&
      !real.startsWith(normalizedRoot + "/") &&
      !real.startsWith(normalizedRoot + "\\")
    );
  } catch {
    // If we can't resolve (e.g. dangling symlink), treat as escaping.
    return true;
  }
}

/**
 * Scan for a `references/` subdirectory within a skill directory and append
 * the contents of any `.md` files found there to the skill body. Each
 * reference file is labeled with a `--- Reference: <Name> ---` header.
 * Files are appended in alphabetical order for deterministic output.
 * Non-`.md` files are ignored. Symlinks that resolve outside the skill
 * directory are skipped. Errors are logged as warnings and the original body
 * is returned unchanged.
 */
function appendReferenceFiles(body: string, directoryPath: string): string {
  try {
    const refsDir = join(directoryPath, "references");
    if (
      !existsSync(refsDir) ||
      isEscapingSymlink(refsDir, directoryPath) ||
      !statSync(refsDir).isDirectory()
    ) {
      return body;
    }

    const entries = readdirSync(refsDir);
    const mdFiles = entries
      .filter((f) => f.toLowerCase().endsWith(".md"))
      .filter((f) => !isEscapingSymlink(join(refsDir, f), directoryPath))
      .sort((a, b) => a.localeCompare(b));

    if (mdFiles.length === 0) return body;

    let result = body;
    for (const filename of mdFiles) {
      const fileContents = readFileSync(join(refsDir, filename), "utf-8");
      const displayName = filename
        .replace(/\.md$/i, "")
        .replace(/[-_]/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase())
        .replace(/\B\w+/g, (w) => w.toLowerCase());
      result += `\n\n--- Reference: ${displayName} ---\n${fileContents}`;
    }

    return result;
  } catch (err) {
    log.warn({ err, directoryPath }, "Failed to read reference files");
    return body;
  }
}

function loadSkillDefinition(skill: SkillSummary): SkillLookupResult {
  let loaded: SkillDefinition | null;
  if (skill.bundled) {
    loaded = readBundledSkillFromDirectory(skill.directoryPath);
  } else if (skill.source === "workspace") {
    // Workspace skills live outside ~/.vellum/workspace/skills, so use their parent
    // directory as the root to avoid the isOutsideSkillsRoot rejection.
    loaded = readSkillFromDirectory(
      skill.directoryPath,
      dirname(skill.directoryPath),
      skill.source,
    );
  } else {
    loaded = readSkillFromDirectory(
      skill.directoryPath,
      getSkillsDir(),
      skill.source,
    );
  }
  if (!loaded) {
    return { error: `Failed to load SKILL.md for "${skill.id}"` };
  }
  // Replace {baseDir} placeholders with the actual skill directory path
  loaded.body = loaded.body.replaceAll("{baseDir}", loaded.directoryPath);
  // Strip feature-gated sections based on assistant feature flags
  loaded.body = applyFeatureGatedSections(loaded.body);
  // Auto-load reference files from references/ subdirectory
  loaded.body = appendReferenceFiles(loaded.body, loaded.directoryPath);
  return { skill: loaded };
}

export function resolveSkillSelector(
  selector: string,
  workspaceSkillsDir?: string,
): SkillSelectorResult {
  const needle = selector.trim();
  if (!needle) {
    return {
      error: "Skill selector is required and must be a non-empty string.",
      errorCode: "invalid_selector",
    };
  }

  const catalog = loadSkillCatalog(workspaceSkillsDir);
  if (catalog.length === 0) {
    return {
      error:
        "No skills are available. Configure ~/.vellum/workspace/skills/SKILLS.md or add skill directories.",
      errorCode: "empty_catalog",
    };
  }

  const exactIdMatch = catalog.find((skill) => skill.id === needle);
  if (exactIdMatch) {
    return { skill: exactIdMatch };
  }

  const exactNameMatches = catalog.filter(
    (skill) =>
      skill.name.toLowerCase() === needle.toLowerCase() ||
      skill.displayName.toLowerCase() === needle.toLowerCase(),
  );
  if (exactNameMatches.length === 1) {
    return { skill: exactNameMatches[0] };
  }
  if (exactNameMatches.length > 1) {
    const ids = exactNameMatches.map((skill) => skill.id).join(", ");
    return {
      error: `Ambiguous skill name "${needle}". Matching IDs: ${ids}`,
      errorCode: "ambiguous",
    };
  }

  const idPrefixMatches = catalog.filter((skill) =>
    skill.id.startsWith(needle),
  );
  if (idPrefixMatches.length === 1) {
    return { skill: idPrefixMatches[0] };
  }
  if (idPrefixMatches.length > 1) {
    const ids = idPrefixMatches.map((skill) => skill.id).join(", ");
    return {
      error: `Ambiguous skill id prefix "${needle}". Matching IDs: ${ids}`,
      errorCode: "ambiguous",
    };
  }

  const knownSkills = catalog.map((skill) => skill.id).join(", ");
  return {
    error: `No skill matched "${needle}". Available skills: ${knownSkills}`,
    errorCode: "not_found",
  };
}

export function loadSkillBySelector(
  selector: string,
  workspaceSkillsDir?: string,
): SkillLookupResult {
  const resolved = resolveSkillSelector(selector, workspaceSkillsDir);
  if (!resolved.skill) {
    return {
      error: resolved.error ?? "Failed to resolve skill selector.",
      errorCode: resolved.errorCode ?? "load_failed",
    };
  }
  return loadSkillDefinition(resolved.skill);
}

// ─── Icon generation ─────────────────────────────────────────────────────────

async function generateSkillIcon(
  name: string,
  description: string,
): Promise<string> {
  const provider = await getConfiguredProvider();
  if (!provider) {
    throw new Error("Configured provider unavailable for icon generation");
  }

  const response = await provider.sendMessage(
    [
      userMessage(
        `Create a 16x16 pixel art SVG icon representing this skill:\nName: ${name}\nDescription: ${description}`,
      ),
    ],
    undefined,
    'You are a pixel art icon designer. When asked, return ONLY a single <svg> element — no explanation, no markdown, no code fences. The SVG must be a 16x16 grid pixel art icon using <rect> elements. Use a limited palette (3-5 colors). Keep it under 2KB. The viewBox should be "0 0 16 16" with each pixel being a 1x1 rect.',
    {
      config: {
        modelIntent: "latency-optimized",
        max_tokens: 1024,
      },
    },
  );

  const text = extractAllText(response);

  const svgMatch = text.match(/<svg[\s\S]*<\/svg>/i);
  if (!svgMatch) {
    throw new Error("No <svg> element found in response");
  }

  return svgMatch[0];
}

/**
 * Synchronously read a cached icon if it exists on disk. Returns undefined if not cached yet.
 */
export function readCachedSkillIcon(directoryPath: string): string | undefined {
  const iconPath = join(directoryPath, "icon.svg");
  if (existsSync(iconPath)) {
    try {
      return readFileSync(iconPath, "utf-8");
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export async function ensureSkillIcon(
  directoryPath: string,
  name: string,
  description: string,
): Promise<string | undefined> {
  const iconPath = join(directoryPath, "icon.svg");

  if (existsSync(iconPath)) {
    try {
      return readFileSync(iconPath, "utf-8");
    } catch {
      log.warn({ iconPath }, "Failed to read existing icon.svg");
      return undefined;
    }
  }

  try {
    const svg = await generateSkillIcon(name, description);
    try {
      writeFileSync(iconPath, svg, "utf-8");
      log.info({ iconPath }, "Generated skill icon");
    } catch (writeErr) {
      log.warn(
        { err: writeErr, iconPath },
        "Failed to cache icon.svg (returning generated icon anyway)",
      );
    }
    return svg;
  } catch (err) {
    log.warn({ err, iconPath }, "Failed to generate skill icon");
    return undefined;
  }
}

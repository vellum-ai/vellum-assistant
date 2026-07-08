import {
  type Dirent,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
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

import { parseFrontmatterFields } from "../skills/frontmatter.js";
import type { InlineCommandExpansion } from "../skills/inline-command-expansions.js";
import { parseInlineCommandExpansions } from "../skills/inline-command-expansions.js";
import { parseToolManifestFile } from "../skills/tool-manifest.js";
import { computeSkillVersionHash } from "../skills/version-hash.js";
import type { OwnerInfo } from "../tools/types.js";
import { getLogger } from "../util/logger.js";
import {
  getWorkspaceDirDisplay,
  getWorkspacePluginsDir,
  getWorkspaceSkillsDir,
} from "../util/platform.js";
import { stripCommentLines } from "../util/strip-comment-lines.js";
import { isAssistantFeatureFlagEnabled } from "./assistant-feature-flags.js";
import { getConfig } from "./loader.js";

const log = getLogger("skills");

// ─── Zod schemas for frontmatter metadata validation ─────────────────────────

const VellumMetadataSchema = z
  .object({
    emoji: z.string().optional(),
    "display-name": z.string().optional(),
    includes: z.array(z.string()).optional(),
    "feature-flag": z.string().optional(),
    "activation-hints": z.array(z.string()).optional(),
    "avoid-when": z.array(z.string()).optional(),
    category: z.string().optional(),
    "always-candidate": z.boolean().optional(),
  })
  .passthrough();

const SkillMetadataSchema = z
  .object({
    icon: z.string().optional(),
    emoji: z.string().optional(),
    vellum: VellumMetadataSchema.optional(),
  })
  .passthrough();

/**
 * Origin of a skill in the merged catalog.
 *
 * - `bundled`: ships inside the assistant binary under `bundled-skills/`.
 * - `managed`: installed into `$VELLUM_WORKSPACE_DIR/skills/` from our catalog.
 * - `workspace`: user-authored skill living in a conversation's working dir.
 * - `extra`: third-party directory roots passed via `loadSkillCatalog`'s
 *   `extraDirs` argument (primarily for tests).
 * - `plugin`: shipped on disk inside an installed plugin at
 *   `<workspaceDir>/plugins/<name>/skills/<id>/SKILL.md`, attributed back to
 *   the owning plugin via its `owner` descriptor.
 */
export type SkillSource =
  | "bundled"
  | "managed"
  | "workspace"
  | "extra"
  | "plugin";

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
  source: SkillSource;
  /**
   * Ownership descriptor identifying the extension that ships this skill,
   * reusing the same {@link OwnerInfo} model the tool registry uses. Set only
   * for `source: "plugin"` skills — `{ kind: "plugin", id: <plugin dir name> }`
   * — attributing them to the installed plugin under `<workspaceDir>/plugins/`.
   */
  owner?: OwnerInfo;
  /** Parsed tool manifest metadata, if the skill has a valid TOOLS.json. */
  toolManifest?: SkillToolManifestMeta;
  /** IDs of child skills that this skill includes (metadata-only, not auto-activated). */
  includes?: string[];
  /** Feature flag ID declared in frontmatter. Only skills with this field are subject to feature flag gating. */
  featureFlag?: string;
  /** Compact routing cues projected into <available_skills> XML to guide skill selection. */
  activationHints?: string[];
  /** Conditions under which this skill should NOT be loaded. */
  avoidWhen?: string[];
  /** Category slug declared in frontmatter, used as a fallback when the skill is not in the Vellum catalog. */
  category?: string;
  /**
   * When true, this skill is pinned into the memory-v3 selector's stable-prefix
   * candidate pool every turn (so the selector can choose it even when no
   * retrieval lane surfaces it). For cross-cutting capabilities whose relevance
   * the model must judge, not embedding similarity.
   */
  alwaysCandidate?: boolean;
  /** Parsed inline command expansion descriptors (`!\`command\``) found in the skill body. */
  inlineCommandExpansions?: InlineCommandExpansion[];
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getSkillsDir(): string {
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

// ─── Frontmatter parsing ─────────────────────────────────────────────────────

interface ParsedFrontmatter {
  name: string;
  displayName: string;
  description: string;
  body: string;
  icon?: string;
  emoji?: string;
  includes?: string[];
  featureFlag?: string;
  activationHints?: string[];
  avoidWhen?: string[];
  category?: string;
  alwaysCandidate?: boolean;
  inlineCommandExpansions?: InlineCommandExpansion[];
}

function normalizeStringArray(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const result = raw
    .filter((item): item is string => typeof item === "string")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return result.length > 0 ? result : undefined;
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
  let icon: string | undefined;
  let emoji: string | undefined;
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
        icon = parsedMeta.icon;
        emoji = vellum?.emoji ?? parsedMeta.emoji;
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
        if (typeof parsedMeta?.icon === "string") {
          icon = parsedMeta.icon;
        }
        if (vellum && typeof vellum === "object") {
          emoji = typeof vellum.emoji === "string" ? vellum.emoji : undefined;
        }
        if (!emoji && typeof parsedMeta?.emoji === "string") {
          emoji = parsedMeta.emoji;
        }
      }
    }
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

  const featureFlag =
    typeof vellum?.["feature-flag"] === "string"
      ? vellum["feature-flag"]
      : undefined;

  const displayName =
    (typeof vellum?.["display-name"] === "string"
      ? vellum["display-name"]
      : undefined) ?? name;

  const activationHints = normalizeStringArray(vellum?.["activation-hints"]);
  const avoidWhen = normalizeStringArray(vellum?.["avoid-when"]);

  const category =
    typeof vellum?.category === "string" && vellum.category.trim().length > 0
      ? vellum.category.trim()
      : undefined;

  const alwaysCandidate =
    typeof vellum?.["always-candidate"] === "boolean"
      ? vellum["always-candidate"]
      : undefined;

  const strippedBody = stripCommentLines(body);

  // Parse inline command expansions from the body (after frontmatter/comment stripping)
  const expansionResult = parseInlineCommandExpansions(strippedBody);
  const inlineCommandExpansions =
    expansionResult.expansions.length > 0
      ? expansionResult.expansions
      : undefined;

  // Fail closed: if there are malformed tokens, log and exclude from parsed expansions
  // (errors are already logged inside parseInlineCommandExpansions)

  return {
    name,
    displayName,
    description,
    body: strippedBody,
    icon,
    emoji,
    includes,
    featureFlag,
    activationHints,
    avoidWhen,
    category,
    alwaysCandidate,
    inlineCommandExpansions,
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
        "Skipping skill directory that resolves outside $VELLUM_WORKSPACE_DIR/skills",
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
        "Skipping SKILL.md that resolves outside $VELLUM_WORKSPACE_DIR/skills",
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
      icon: parsed.icon,
      emoji: parsed.emoji,

      source,
      toolManifest: detectToolManifest(directoryPath),
      includes: parsed.includes,
      featureFlag: parsed.featureFlag,
      activationHints: parsed.activationHints,
      avoidWhen: parsed.avoidWhen,
      category: parsed.category,
      alwaysCandidate: parsed.alwaysCandidate,
      inlineCommandExpansions: parsed.inlineCommandExpansions,
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
      icon: parsed.icon,
      emoji: parsed.emoji,

      source: "bundled",
      toolManifest: detectToolManifest(directoryPath),
      includes: parsed.includes,
      featureFlag: parsed.featureFlag,
      activationHints: parsed.activationHints,
      avoidWhen: parsed.avoidWhen,
      category: parsed.category,
      alwaysCandidate: parsed.alwaysCandidate,
      inlineCommandExpansions: parsed.inlineCommandExpansions,
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
      icon: skill.icon,
      emoji: skill.emoji,

      source: "bundled",
      toolManifest: skill.toolManifest,
      includes: skill.includes,
      featureFlag: skill.featureFlag,
      activationHints: skill.activationHints,
      avoidWhen: skill.avoidWhen,
      category: skill.category,
      alwaysCandidate: skill.alwaysCandidate,
      inlineCommandExpansions: skill.inlineCommandExpansions,
    });
  }

  return skills;
}

function discoverSkillDirectories(skillsDir: string): string[] {
  if (!existsSync(skillsDir)) return [];

  const dirs: string[] = [];
  try {
    const entries = readdirSync(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
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

/**
 * Whether `pluginDir` is a recognized installed plugin: it must carry a
 * parseable `package.json` whose `name` equals the directory name. This
 * mirrors the external plugin loader's recognition gate, which skips any
 * directory whose `manifest.name` does not match its directory name.
 *
 * The caller is responsible for the missing-`package.json` case (it emits a
 * diagnostic warning); this function only judges a manifest that is present.
 */
function isRecognizedPluginDir(pluginDir: string, dirName: string): boolean {
  const manifestPath = join(pluginDir, "package.json");
  if (!existsSync(manifestPath)) return false;
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf-8"));
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      "name" in parsed &&
      (parsed as { name: unknown }).name === dirName
    );
  } catch (err) {
    log.warn(
      { err, manifestPath },
      "Skipping plugin dir with unparseable package.json for resident skills",
    );
    return false;
  }
}

/**
 * Discover skills shipped on disk inside installed plugins. Each installed
 * plugin — a directory under `<workspaceDir>/plugins/` recognized by
 * {@link isRecognizedPluginDir} — may ship skills at `skills/<id>/SKILL.md`.
 * Returned summaries are attributed to the owning plugin via their `owner`
 * descriptor (`{ kind: "plugin", id: <plugin dir name> }`).
 */
function discoverPluginResidentSkills(): SkillSummary[] {
  const pluginsDir = getWorkspacePluginsDir();
  if (!existsSync(pluginsDir)) return [];

  let entries: Dirent[];
  try {
    entries = readdirSync(pluginsDir, { withFileTypes: true });
  } catch (err) {
    log.warn(
      { err, pluginsDir },
      "Failed to read plugins directory for resident skills",
    );
    return [];
  }

  const summaries: SkillSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const pluginDir = join(pluginsDir, entry.name);

    // A directory under `plugins/` with no `package.json` is not a plugin the
    // runtime can load, so its skills are never surfaced. This is an easy
    // footgun — a plugin dropped in without its manifest looks installed but
    // silently contributes nothing — so warn loudly with the path rather than
    // skipping in silence, to make the misconfiguration diagnosable.
    if (!existsSync(join(pluginDir, "package.json"))) {
      log.warn(
        { pluginDir },
        "Plugin directory is missing package.json — skipping; its skills will not be available. Add a package.json whose `name` matches the directory.",
      );
      continue;
    }

    // Honor the `.disabled` sentinel the runtime plugin scan checks
    // (`plugins/mtime-cache.ts`): a disabled plugin contributes no hooks or
    // tools, so its resident skills must not be loadable either.
    if (existsSync(join(pluginDir, ".disabled"))) continue;

    // Mirror the plugin loader's recognition gate: a directory is a real
    // installed plugin only if its `package.json` `name` matches the directory.
    // This rejects staging dirs and malformed/mismatched clones (e.g. an
    // un-adapted `caveman-installer`) that the loader itself would skip, so the
    // catalog never surfaces skills from a directory the runtime would refuse
    // to load.
    if (!isRecognizedPluginDir(pluginDir, entry.name)) continue;

    const skillsDir = join(pluginDir, "skills");
    if (!existsSync(skillsDir)) continue;

    for (const directory of discoverSkillDirectories(skillsDir)) {
      const skill = readSkillFromDirectory(directory, skillsDir, "plugin");
      if (!skill) continue;
      summaries.push({
        ...skillSummaryFromDefinition(skill, "plugin"),
        owner: { kind: "plugin", id: entry.name },
      });
    }
  }

  return summaries;
}

// ─── Catalog loading ─────────────────────────────────────────────────────────

/**
 * Scope a list of skills to a conversation's per-chat plugin selection.
 *
 * `effectiveEnabledPluginSet` is the conversation's effective set as produced
 * by `getEffectiveEnabledPluginSet`: `null` means there is no per-chat
 * restriction, so the input is returned unchanged (all globally-enabled
 * plugins apply). When a set is given, a plugin-contributed skill
 * (`owner.kind === "plugin"`) survives only if its owning plugin id is in the
 * set; non-plugin skills (bundled/managed/workspace/extra) are always retained.
 *
 * Pure: returns the same array reference when there is no restriction, and a
 * filtered copy otherwise, so callers can pass a cached catalog without
 * mutating the cache.
 */
export function filterSkillsByEnabledPlugins(
  skills: SkillSummary[],
  effectiveEnabledPluginSet: Set<string> | null,
): SkillSummary[] {
  if (effectiveEnabledPluginSet === null) return skills;
  return skills.filter((skill) => {
    const owner = skill.owner;
    if (owner?.kind !== "plugin") return true;
    return effectiveEnabledPluginSet.has(owner.id);
  });
}

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
    icon: skill.icon,
    emoji: skill.emoji,
    source,
    toolManifest: skill.toolManifest,
    includes: skill.includes,
    featureFlag: skill.featureFlag,
    activationHints: skill.activationHints,
    avoidWhen: skill.avoidWhen,
    category: skill.category,
    alwaysCandidate: skill.alwaysCandidate,
    inlineCommandExpansions: skill.inlineCommandExpansions,
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
            emoji: parsed.emoji,

            source: "extra",
            toolManifest: detectToolManifest(directory),
            includes: parsed.includes,
            featureFlag: parsed.featureFlag,
            activationHints: parsed.activationHints,
            avoidWhen: parsed.avoidWhen,
            category: parsed.category,
            alwaysCandidate: parsed.alwaysCandidate,
            inlineCommandExpansions: parsed.inlineCommandExpansions,
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

  // Discover skills shipped on disk inside installed plugins. They sit above
  // bundled/extra but below managed and workspace so a user-authored
  // filesystem skill can override a plugin-provided skill by declaring the
  // same id under `$VELLUM_WORKSPACE_DIR/skills/`.
  const pluginSkills = discoverPluginResidentSkills();
  for (const skill of pluginSkills) {
    if (seenIds.has(skill.id)) {
      const existingIndex = catalog.findIndex((s) => s.id === skill.id);
      if (
        existingIndex !== -1 &&
        (catalog[existingIndex].source === "bundled" ||
          catalog[existingIndex].source === "extra")
      ) {
        log.info(
          { id: skill.id, pluginName: skill.owner?.id },
          "Plugin skill overrides bundled/extra skill",
        );
        catalog[existingIndex] = skill;
        continue;
      }
      log.warn(
        { id: skill.id, pluginName: skill.owner?.id },
        "Skipping duplicate plugin skill id (already present in catalog)",
      );
      continue;
    }
    seenIds.add(skill.id);
    catalog.push(skill);
  }

  // Load managed (user) skills, which take precedence over bundled skills with the same ID
  const skillsDir = getSkillsDir();
  const directories = discoverSkillDirectories(skillsDir);

  for (const directory of directories) {
    const skill = readSkillFromDirectory(directory, skillsDir, "managed");
    if (!skill) continue;

    if (seenIds.has(skill.id)) {
      // If the existing entry is bundled, extra, or plugin-contributed, the
      // user skill overrides it. Only another `managed` or `workspace` entry
      // (already at or above managed precedence) is treated as a true
      // duplicate.
      const existingIndex = catalog.findIndex((s) => s.id === skill.id);
      if (
        existingIndex !== -1 &&
        (catalog[existingIndex].bundled ||
          catalog[existingIndex].source === "extra" ||
          catalog[existingIndex].source === "plugin")
      ) {
        log.info(
          {
            id: skill.id,
            directory,
            overriding: catalog[existingIndex].source,
          },
          "User skill overrides existing catalog entry",
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
          icon: parsed.icon,
          emoji: parsed.emoji,

          source: "workspace",
          toolManifest: detectToolManifest(directory),
          includes: parsed.includes,
          featureFlag: parsed.featureFlag,
          activationHints: parsed.activationHints,
          avoidWhen: parsed.avoidWhen,
          category: parsed.category,
          alwaysCandidate: parsed.alwaysCandidate,
          inlineCommandExpansions: parsed.inlineCommandExpansions,
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
    return isAssistantFeatureFlagEnabled(flagId, config) ? content : "";
  });

  result = result.replace(altRe, (_match, flagId: string, content: string) => {
    return isAssistantFeatureFlagEnabled(flagId, config) ? "" : content;
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
 * Check for a `references/` subdirectory within a skill directory and return
 * a formatted listing of available `.md` reference files with full absolute
 * paths. Returns `null` if no references exist. Files are discovered
 * recursively through subdirectories and listed alphabetically within each
 * directory level. Non-`.md` files are ignored. Symlinks that resolve
 * outside the skill directory are skipped.
 */
export function listReferenceFiles(directoryPath: string): string | null {
  try {
    const refsDir = join(directoryPath, "references");
    if (
      !existsSync(refsDir) ||
      isEscapingSymlink(refsDir, directoryPath) ||
      !statSync(refsDir).isDirectory()
    ) {
      return null;
    }

    const entries = readdirSync(refsDir, { recursive: true }) as string[];
    const mdFiles = entries
      .filter((f) => f.toLowerCase().endsWith(".md"))
      .filter((f) => {
        // Check the file itself
        if (isEscapingSymlink(join(refsDir, f), directoryPath)) return false;
        // Check all intermediate directory components (e.g. for "sub/dir/file.md"
        // check "sub" and "sub/dir") to prevent traversal through symlinked dirs.
        const parts = f.split("/");
        for (let i = 1; i < parts.length; i++) {
          const ancestor = join(refsDir, ...parts.slice(0, i));
          if (isEscapingSymlink(ancestor, directoryPath)) return false;
        }
        return true;
      })
      .sort((a, b) => a.localeCompare(b));

    if (mdFiles.length === 0) return null;

    const lines = [
      "## Reference Files",
      "",
      "The following reference files are available in this skill's directory. Use `file_read` to load any that are relevant to the current task:",
      "",
    ];
    for (const filepath of mdFiles) {
      lines.push(`- \`${join(refsDir, filepath)}\` (references/${filepath})`);
    }

    return lines.join("\n");
  } catch (err) {
    log.warn({ err, directoryPath }, "Failed to list reference files");
    return null;
  }
}

function loadSkillDefinition(skill: SkillSummary): SkillLookupResult {
  let loaded: SkillDefinition | null;
  if (skill.bundled) {
    loaded = readBundledSkillFromDirectory(skill.directoryPath);
  } else if (skill.source === "workspace" || skill.source === "plugin") {
    // Workspace and plugin-resident skills live outside
    // $VELLUM_WORKSPACE_DIR/skills, so use the skill's parent directory as the
    // root to avoid the isOutsideSkillsRoot rejection.
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
  loaded.owner = skill.owner;
  // Replace {baseDir} placeholders with the actual skill directory path
  loaded.body = loaded.body.replaceAll("{baseDir}", loaded.directoryPath);
  // Replace {workspaceDir} placeholders with the runtime workspace display path
  loaded.body = loaded.body.replaceAll(
    "{workspaceDir}",
    getWorkspaceDirDisplay(),
  );
  // Strip feature-gated sections based on assistant feature flags
  loaded.body = applyFeatureGatedSections(loaded.body);

  // Re-parse inline command expansions after placeholder substitution.
  // The initial parse (during SKILL.md parsing) produces byte offsets against
  // the pre-substitution body. Since {baseDir} and {workspaceDir} replacements
  // change the body length, those offsets become stale. Re-parsing ensures the
  // offsets match the final body that renderInlineCommands will operate on.
  if (
    loaded.inlineCommandExpansions &&
    loaded.inlineCommandExpansions.length > 0
  ) {
    const reparse = parseInlineCommandExpansions(loaded.body);
    loaded.inlineCommandExpansions =
      reparse.expansions.length > 0 ? reparse.expansions : undefined;
  }

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
      error: `No skills are available. Add skill directories under ${getWorkspaceDirDisplay()}/skills/.`,
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

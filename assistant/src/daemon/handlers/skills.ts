import { execSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, sep } from "node:path";

import { isAssistantFeatureFlagEnabled } from "../../config/assistant-feature-flags.js";
import {
  getConfig,
  invalidateConfigCache,
  loadRawConfig,
  saveRawConfig,
} from "../../config/loader.js";
import { resolveSkillStates, skillFlagKey } from "../../config/skill-state.js";
import { loadSkillCatalog, type SkillSummary } from "../../config/skills.js";
import {
  deleteSkillCapabilityNode,
  seedSkillGraphNodes,
  seedUninstalledCatalogSkillMemories,
} from "../../memory/graph/capability-seed.js";
import {
  createTimeout,
  extractText,
  getConfiguredProvider,
  userMessage,
} from "../../providers/provider-send-message.js";
import { isTextMimeType as isTextMime } from "../../runtime/routes/workspace-utils.js";
import { getCatalog } from "../../skills/catalog-cache.js";
import {
  hasHiddenOrSkippedSegment,
  readCatalogSkillFileContent,
  sanitizeRelativePath,
  type SkillFileEntry,
  SKIP_DIRS,
} from "../../skills/catalog-files.js";
import {
  installSkillLocally,
  upsertSkillsIndex,
} from "../../skills/catalog-install.js";
import { filterByQuery } from "../../skills/catalog-search.js";
import {
  clawhubCheckUpdates,
  clawhubInspect,
  type ClawhubInspectResult,
  clawhubInstall,
  clawhubSearch,
  clawhubUpdate,
} from "../../skills/clawhub.js";
import {
  readInstallMeta,
  type SkillInstallMeta,
} from "../../skills/install-meta.js";
import {
  createManagedSkill,
  deleteManagedSkill,
  removeSkillsIndexEntry,
  validateManagedSkillId,
} from "../../skills/managed-store.js";
import {
  installExternalSkill,
  resolveSkillSource,
  searchSkillsRegistry,
} from "../../skills/skillssh-registry.js";
import { getWorkspaceSkillsDir } from "../../util/platform.js";
import type {
  SkillDetailResponse,
  SkillFileContentResponse,
  SlimSkillResponse,
} from "../message-types/skills.js";
import {
  CONFIG_RELOAD_DEBOUNCE_MS,
  ensureSkillEntry,
  type HandlerContext,
  log,
} from "./shared.js";

// ─── MIME detection helpers ───────────────────────────────────────────────────

const MAX_INLINE_SIZE = 2 * 1024 * 1024; // 2 MB

// ─── Shared context for standalone functions ─────────────────────────────────

/**
 * Minimal context needed by the standalone skill business-logic functions.
 * HandlerContext satisfies this interface, but HTTP routes can also provide
 * a compatible object without coupling to handler internals.
 */
export interface SkillOperationContext {
  debounceTimers: HandlerContext["debounceTimers"];
  setSuppressConfigReload(value: boolean): void;
  updateConfigFingerprint(): void;
  broadcast: HandlerContext["broadcast"];
}

// ─── Frontmatter parsing ─────────────────────────────────────────────────────

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

interface ParsedFrontmatter {
  skillId?: string;
  name?: string;
  description?: string;
  emoji?: string;
  body: string;
}

function parseFrontmatter(sourceText: string): ParsedFrontmatter {
  const match = FRONTMATTER_RE.exec(sourceText);
  if (!match) return { body: sourceText };

  const yamlBlock = match[1];
  const body = match[2].replace(/\r\n/g, "\n");

  const result: ParsedFrontmatter = { body };

  // Simple YAML key-value extraction (handles quoted and unquoted values)
  for (const line of yamlBlock.split(/\r?\n/)) {
    const kvMatch = /^(\w[\w-]*):\s*(.+)$/.exec(line.trim());
    if (!kvMatch) continue;
    const key = kvMatch[1];
    // Strip surrounding quotes
    let value = kvMatch[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    switch (key) {
      case "skill-id":
      case "skillId":
      case "id":
        result.skillId = value;
        break;
      case "name":
        result.name = value;
        break;
      case "description":
        result.description = value;
        break;
      case "emoji":
        result.emoji = value;
        break;
    }
  }

  return result;
}

// ─── Slug normalization ──────────────────────────────────────────────────────

function toSkillSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-") // replace non-valid chars with hyphens
    .replace(/^[^a-z0-9]+/, "") // must start with alphanumeric
    .replace(/-+/g, "-") // collapse multiple hyphens
    .slice(0, 50)
    .replace(/-$/, ""); // no trailing hyphen (after truncation)
}

// ─── Deterministic heuristic draft ───────────────────────────────────────────

function heuristicDraft(body: string): {
  skillId: string;
  name: string;
  description: string;
  emoji: string;
} {
  const lines = body.split("\n").filter((l) => l.trim());
  const firstLine = lines[0]?.trim() ?? "";
  const name =
    firstLine.replace(/^#+\s*/, "").slice(0, 100) || "Untitled Skill";
  const skillId = toSkillSlug(name) || "untitled-skill";
  const description = body.trim().slice(0, 200) || "No description provided";
  return { skillId, name, description, emoji: "\u{1F4DD}" };
}

const LLM_DRAFT_TIMEOUT_MS = 15_000;

// ─── Standalone business-logic functions ─────────────────────────────────────
// These are consumed by both the handlers below and the HTTP route layer.

/** Helper: suppress config reload, save, debounce, and update fingerprint. */
function saveConfigWithSuppression(
  raw: Record<string, unknown>,
  ctx: SkillOperationContext,
): void {
  ctx.setSuppressConfigReload(true);
  try {
    saveRawConfig(raw);
  } catch (err) {
    ctx.setSuppressConfigReload(false);
    throw err;
  }
  invalidateConfigCache();

  ctx.debounceTimers.schedule(
    "__suppress_reset__",
    () => {
      ctx.setSuppressConfigReload(false);
    },
    CONFIG_RELOAD_DEBOUNCE_MS,
  );

  ctx.updateConfigFingerprint();
}

/**
 * Shared post-install logic for catalog, skillssh, and clawhub install paths
 * in the daemon. Handles catalog reload, auto-enable, broadcast, and memory
 * seeding.
 *
 * SKILLS.md indexing and dependency installation are handled separately:
 * `installSkillLocally` and `installExternalSkill` handle them internally
 * (so both CLI and daemon callers get correct behavior), while the clawhub
 * path handles them inline in `installSkill()` since `clawhubInstall` only
 * runs the clawhub CLI and writes metadata.
 *
 * NOT used for bundled skills — those have a simpler inline path in
 * `installSkill()` that only auto-enables, broadcasts, and seeds memories.
 */
export function postInstallSkill(
  skillId: string,
  _skillDir: string,
  ctx: SkillOperationContext,
): void {
  // Reload skill catalog so the newly installed skill is picked up
  loadSkillCatalog();

  // Auto-enable the skill in config
  try {
    const raw = loadRawConfig();
    ensureSkillEntry(raw, skillId).enabled = true;
    saveConfigWithSuppression(raw, ctx);
    ctx.broadcast({
      type: "skills_state_changed",
      name: skillId,
      state: "enabled",
    });
  } catch (err) {
    log.warn({ err, skillId }, "Failed to auto-enable installed skill");
  }

  // Seed skill memories
  seedSkillGraphNodes();
  void seedUninstalledCatalogSkillMemories().catch(() => {});
}

// ─── Kind / origin / status derivation ───────────────────────────────────────

/** Map the old `source` field to the new `kind` axis. */
function deriveKind(
  source: "bundled" | "managed" | "workspace" | "extra" | "catalog",
): SlimSkillResponse["kind"] {
  if (source === "bundled") return "bundled";
  if (source === "catalog") return "catalog";
  return "installed"; // managed, workspace, extra
}

/** Map a resolved skill to its `origin`, using install-meta.json when available. */
function deriveOrigin(
  kind: SlimSkillResponse["kind"],
  directoryPath: string,
  installMeta?: SkillInstallMeta | null,
): SlimSkillResponse["origin"] {
  if (kind === "bundled") return "vellum";
  if (kind === "catalog") return "vellum";
  // For installed skills, use provided install-meta or read from disk.
  // null means "already read, nothing found" — don't re-read.
  const meta =
    installMeta !== undefined ? installMeta : readInstallMeta(directoryPath);
  return meta?.origin ?? "custom";
}

/** Sort rank by kind: bundled first, then catalog, then installed. */
function kindSortRank(kind: SlimSkillResponse["kind"]): number {
  if (kind === "bundled") return 0;
  if (kind === "catalog") return 1;
  return 2; // installed
}

/** Convert a resolved skill to a SlimSkillResponse. */
function toSlimSkillResponse(
  summary: SkillSummary,
  state: "enabled" | "disabled",
): SlimSkillResponse {
  const kind = deriveKind(summary.source);
  // Read install-meta once and pass it through to avoid redundant file I/O.
  // Use undefined to mean "not yet read"; null means "read but no metadata found".
  const installMeta =
    kind === "installed" ? readInstallMeta(summary.directoryPath) : undefined;
  const origin = deriveOrigin(kind, summary.directoryPath, installMeta);
  const status: SlimSkillResponse["status"] = state;

  const base = {
    id: summary.id,
    name: summary.displayName,
    description: summary.description,
    emoji: summary.emoji,
    kind,
    status,
  } as const;

  switch (origin) {
    case "vellum":
      return { ...base, origin };
    case "clawhub": {
      const meta =
        installMeta !== undefined
          ? installMeta
          : readInstallMeta(summary.directoryPath);
      return {
        ...base,
        origin,
        slug: meta?.slug ?? summary.id,
        author: "",
        stars: 0,
        installs: 0,
        reports: 0,
      };
    }
    case "skillssh": {
      const meta =
        installMeta !== undefined
          ? installMeta
          : readInstallMeta(summary.directoryPath);
      return {
        ...base,
        origin,
        slug: meta?.slug ?? summary.id,
        sourceRepo: meta?.sourceRepo ?? "",
        installs: 0,
      };
    }
    case "custom":
      return { ...base, origin };
  }
}

export function listSkills(_ctx: SkillOperationContext): SlimSkillResponse[] {
  const config = getConfig();
  const catalog = loadSkillCatalog();
  const resolved = resolveSkillStates(catalog, config);

  const items = resolved.map((r) => toSlimSkillResponse(r.summary, r.state));

  // Sort by kind rank, then alphabetical by name within each tier.
  items.sort((a, b) => {
    const rankDiff = kindSortRank(a.kind) - kindSortRank(b.kind);
    if (rankDiff !== 0) return rankDiff;
    return a.name.localeCompare(b.name);
  });

  return items;
}

/**
 * List installed skills merged with available catalog skills.
 * Installed skills take precedence when deduplicating by ID.
 */
export async function listSkillsWithCatalog(
  ctx: SkillOperationContext,
): Promise<SlimSkillResponse[]> {
  const installed = listSkills(ctx);
  const installedIds = new Set(installed.map((s) => s.id));

  let catalogSkills: import("../../skills/catalog-install.js").CatalogSkill[];
  try {
    catalogSkills = await getCatalog();
  } catch {
    // If catalog fetch fails, return installed-only
    return installed;
  }

  // All entries from the Vellum platform API are first-party.
  // Create SlimSkillResponses for catalog skills not already installed.
  const available: SlimSkillResponse[] = catalogSkills
    .filter((cs) => !installedIds.has(cs.id))
    .map((cs) => ({
      id: cs.id,
      name: cs.metadata?.vellum?.["display-name"] ?? cs.name,
      description: cs.description,
      emoji: cs.emoji,
      kind: "catalog" as const,
      origin: "vellum" as const,
      status: "available" as const,
    }));

  const merged = [...installed, ...available];

  // Sort by kind rank, then alphabetical by name
  merged.sort((a, b) => {
    const rankDiff = kindSortRank(a.kind) - kindSortRank(b.kind);
    if (rankDiff !== 0) return rankDiff;
    return a.name.localeCompare(b.name);
  });

  return merged;
}

/** Look up a single skill by ID from the resolved catalog, returning its SlimSkillResponse. */
function findSkillById(
  skillId: string,
): { item: SlimSkillResponse; summary: SkillSummary } | undefined {
  const config = getConfig();
  const catalog = loadSkillCatalog();
  const resolved = resolveSkillStates(catalog, config);
  const match = resolved.find((r) => r.summary.id === skillId);
  if (!match) return undefined;

  const r = match;
  const item = toSlimSkillResponse(r.summary, r.state);
  return { item, summary: r.summary };
}

export async function getSkill(
  skillId: string,
  _ctx: SkillOperationContext,
): Promise<{ skill: SkillDetailResponse } | { error: string; status: number }> {
  const found = findSkillById(skillId);
  if (!found) {
    return { error: `Skill "${skillId}" not found`, status: 404 };
  }

  const slim = found.item;

  // Build the detail response as a flat discriminated union on origin.
  // Origin-specific fields are spread directly at the top level.
  if (slim.origin === "clawhub") {
    // Start with slim clawhub fields, then enrich with inspect data.
    const detail: SkillDetailResponse = {
      id: slim.id,
      name: slim.name,
      description: slim.description,
      emoji: slim.emoji,
      kind: slim.kind,
      origin: slim.origin,
      status: slim.status,
      slug: slim.slug,
      author: slim.author,
      stars: slim.stars,
      installs: slim.installs,
      reports: slim.reports,
      publishedAt: slim.publishedAt,
    };
    try {
      const inspectResult = await clawhubInspect(slim.slug);
      if (inspectResult.data) {
        const data = inspectResult.data;
        (detail as { owner?: typeof data.owner }).owner = data.owner;
        (detail as { stats?: typeof data.stats }).stats = data.stats;
        (
          detail as { latestVersion?: typeof data.latestVersion }
        ).latestVersion = data.latestVersion;
        (detail as { createdAt?: typeof data.createdAt }).createdAt =
          data.createdAt;
        (detail as { updatedAt?: typeof data.updatedAt }).updatedAt =
          data.updatedAt;
      }
    } catch (err) {
      log.warn({ err, skillId }, "Failed to enrich clawhub skill detail");
    }
    return { skill: detail };
  }

  if (slim.origin === "skillssh") {
    const detail: SkillDetailResponse = {
      id: slim.id,
      name: slim.name,
      description: slim.description,
      emoji: slim.emoji,
      kind: slim.kind,
      origin: slim.origin,
      status: slim.status,
      slug: slim.slug,
      sourceRepo: slim.sourceRepo,
      installs: slim.installs,
    };
    return { skill: detail };
  }

  // vellum or custom origin — base fields only
  const detail: SkillDetailResponse = {
    id: slim.id,
    name: slim.name,
    description: slim.description,
    emoji: slim.emoji,
    kind: slim.kind,
    origin: slim.origin,
    status: slim.status,
  };
  return { skill: detail };
}

// ─── Skill file listing ──────────────────────────────────────────────────────

// `SkillFileEntry` lives in `../../skills/catalog-files.ts` to keep a single
// source of truth for the shape and avoid a circular import (catalog-files
// depends on `catalog-cache.ts`, which would otherwise be reachable via this
// handler module). Re-exported here so handlers can import it alongside
// the other skill handler exports.
export type { SkillFileEntry } from "../../skills/catalog-files.js";

/**
 * Returns true if `filePath` is a symlink whose resolved real path escapes
 * `rootDir`. Symlinks that stay within `rootDir` are allowed; only those that
 * point outside are considered unsafe. Dangling symlinks are treated as escaping.
 */
function isEscapingSymlink(filePath: string, rootDir: string): boolean {
  try {
    if (!lstatSync(filePath).isSymbolicLink()) return false;
    const real = realpathSync(filePath);
    const normalizedRoot = realpathSync(rootDir);
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

function readDirRecursive(dir: string, rootDir: string): SkillFileEntry[] {
  const entries: SkillFileEntry[] = [];
  let dirents;
  try {
    dirents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return entries;
  }
  for (const dirent of dirents) {
    if (dirent.name.startsWith(".")) continue;
    const fullPath = join(dir, dirent.name);
    // Skip symlinks that escape the skill directory root
    if (isEscapingSymlink(fullPath, rootDir)) continue;
    if (dirent.isDirectory()) {
      if (SKIP_DIRS.has(dirent.name)) continue;
      entries.push(...readDirRecursive(fullPath, rootDir));
      continue;
    }
    if (!dirent.isFile()) continue;
    try {
      const stat = statSync(fullPath);
      const mimeType = Bun.file(fullPath).type;
      const isText = isTextMime(mimeType, dirent.name);
      let content: string | null = null;
      if (isText && stat.size <= MAX_INLINE_SIZE) {
        content = readFileSync(fullPath, "utf-8");
      }
      entries.push({
        path: relative(rootDir, fullPath),
        name: dirent.name,
        size: stat.size,
        mimeType,
        isBinary: !isText,
        content,
      });
    } catch {
      // Skip files that can't be stat'd
    }
  }
  return entries;
}

/**
 * Read a single file's content from an installed or catalog skill.
 *
 * Installed-skill path (eager): reads the file directly from the skill's
 * on-disk directory. Applies lexical containment, symlink rejection, and
 * realpath containment checks for defense in depth.
 *
 * Catalog fallback: when the skill id is not backed by a local directory
 * (e.g. an uninstalled Vellum catalog skill), delegates to
 * `readCatalogSkillFileContent`, which handles both the dev-mode repo
 * checkout path and the platform preview API path internally.
 */
export async function getSkillFileContent(
  skillId: string,
  relativePath: string,
  _ctx: SkillOperationContext,
): Promise<SkillFileContentResponse | { error: string; status: number }> {
  const sanitized = sanitizeRelativePath(relativePath);
  if (!sanitized) {
    return { error: "Invalid path", status: 400 };
  }

  // Reject any sanitized path that references a hidden segment (dotfiles
  // like `.env`, dot-dirs like `.git`) or a SKIP_DIRS segment (e.g.
  // `node_modules`, `__pycache__`). Both file-listing endpoints (installed
  // and catalog) intentionally omit these entries, so allowing the content
  // endpoint to read them would create a data-exposure path and break
  // parity with the visible file list. This check runs BEFORE both the
  // installed-skill disk read and the catalog fallback so the rejection
  // is uniform regardless of source.
  if (hasHiddenOrSkippedSegment(sanitized)) {
    return { error: "Invalid path", status: 400 };
  }

  const found = findSkillById(skillId);
  if (found && existsSync(found.summary.directoryPath)) {
    const dir = found.summary.directoryPath;
    const abs = join(dir, sanitized);

    // Lexical containment: the resolved absolute path must stay inside the
    // skill directory even after `join` normalization. Cheap short-circuit
    // before any fs calls.
    if (!(abs === dir || abs.startsWith(dir + sep))) {
      return { error: "Invalid path", status: 400 };
    }

    // Defense-in-depth symlink rejection: refuse to follow a symlinked file
    // inside the skill dir that could point outside the root. Also catches
    // symlinked parent directories via a realpath containment check.
    let lstat;
    try {
      lstat = lstatSync(abs);
    } catch {
      return { error: "File not found", status: 404 };
    }
    if (lstat.isSymbolicLink()) {
      return { error: "File not found", status: 404 };
    }
    if (!lstat.isFile()) {
      return { error: "File not found", status: 404 };
    }

    let realAbs: string;
    let realDir: string;
    try {
      realAbs = realpathSync(abs);
      realDir = realpathSync(dir);
    } catch {
      return { error: "File not found", status: 404 };
    }
    if (!(realAbs === realDir || realAbs.startsWith(realDir + sep))) {
      return { error: "File not found", status: 404 };
    }

    let stat;
    try {
      stat = statSync(abs);
    } catch {
      return { error: "File not found", status: 404 };
    }
    if (!stat.isFile()) {
      return { error: "File not found", status: 404 };
    }

    const name = basename(sanitized);
    const mimeType = Bun.file(abs).type;
    const isText = isTextMime(mimeType, name);
    const isBinary = !isText;
    let content: string | null = null;
    if (isText && stat.size <= MAX_INLINE_SIZE) {
      try {
        content = readFileSync(abs, "utf-8");
      } catch {
        content = null;
      }
    }
    return {
      path: sanitized,
      name,
      size: stat.size,
      mimeType,
      isBinary,
      content,
    };
  }

  // Catalog fallback: skill is not installed locally (or its directory is
  // missing on disk). Try the catalog preview helper, which handles both
  // dev-mode repo checkouts and the platform preview API.
  let catalog: Awaited<ReturnType<typeof getCatalog>> = [];
  try {
    catalog = await getCatalog();
  } catch {
    catalog = [];
  }
  const inCatalog = catalog.some((s) => s.id === skillId);
  if (!inCatalog) {
    return { error: "Skill not found", status: 404 };
  }

  const result = await readCatalogSkillFileContent(skillId, sanitized);
  if (!result) {
    return { error: "File not found", status: 404 };
  }
  return {
    path: result.path,
    name: result.name,
    size: result.size,
    mimeType: result.mimeType,
    isBinary: result.isBinary,
    content: result.content,
  };
}

export function getSkillFiles(
  skillId: string,
  _ctx: SkillOperationContext,
):
  | { skill: SlimSkillResponse; files: SkillFileEntry[] }
  | { error: string; status: number } {
  const found = findSkillById(skillId);
  if (!found) {
    return { error: `Skill "${skillId}" not found`, status: 404 };
  }

  const dirPath = found.summary.directoryPath;
  if (!existsSync(dirPath)) {
    return { error: `Skill directory not found for "${skillId}"`, status: 404 };
  }

  const files = readDirRecursive(dirPath, dirPath);
  files.sort((a, b) => a.path.localeCompare(b.path));

  return { skill: found.item, files };
}

export function enableSkill(
  skillId: string,
  ctx: SkillOperationContext,
): { success: true } | { success: false; error: string } {
  try {
    const raw = loadRawConfig();
    ensureSkillEntry(raw, skillId).enabled = true;
    saveConfigWithSuppression(raw, ctx);
    ctx.broadcast({
      type: "skills_state_changed",
      name: skillId,
      state: "enabled",
    });
    seedSkillGraphNodes();
    void seedUninstalledCatalogSkillMemories().catch(() => {});
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to enable skill");
    return { success: false, error: message };
  }
}

export function disableSkill(
  skillId: string,
  ctx: SkillOperationContext,
): { success: true } | { success: false; error: string } {
  try {
    const raw = loadRawConfig();
    ensureSkillEntry(raw, skillId).enabled = false;
    saveConfigWithSuppression(raw, ctx);
    ctx.broadcast({
      type: "skills_state_changed",
      name: skillId,
      state: "disabled",
    });
    seedSkillGraphNodes();
    void seedUninstalledCatalogSkillMemories().catch(() => {});
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to disable skill");
    return { success: false, error: message };
  }
}

export function configureSkill(
  skillId: string,
  config: {
    env?: Record<string, string>;
    apiKey?: string;
    config?: Record<string, unknown>;
  },
  ctx: SkillOperationContext,
): { success: true } | { success: false; error: string } {
  try {
    const raw = loadRawConfig();
    const entry = ensureSkillEntry(raw, skillId);
    if (config.env) entry.env = config.env;
    if (config.apiKey !== undefined) entry.apiKey = config.apiKey;
    if (config.config) entry.config = config.config;
    saveConfigWithSuppression(raw, ctx);
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to configure skill");
    return { success: false, error: message };
  }
}

/**
 * Check whether a slug looks like a skills.sh multi-segment format
 * (e.g. `owner/repo/skill-name` — three or more `/`-separated segments).
 */
function looksLikeSkillsShSlug(slug: string): boolean {
  return slug.split("/").length >= 3;
}

export async function installSkill(
  spec: {
    slug: string;
    version?: string;
    origin?: "clawhub" | "skillssh";
    contactId?: string;
  },
  ctx: SkillOperationContext,
): Promise<{ success: true } | { success: false; error: string }> {
  try {
    // Bundled skills are already available — no install needed
    const catalog = loadSkillCatalog();

    // Feature flag gate: reject install if the skill's flag is disabled
    const config = getConfig();
    const flaggedSkill = catalog.find((s) => s.id === spec.slug);
    if (flaggedSkill) {
      const flagKey = skillFlagKey(flaggedSkill);
      if (flagKey && !isAssistantFeatureFlagEnabled(flagKey, config)) {
        return {
          success: false,
          error: `Skill "${spec.slug}" is currently unavailable (disabled by feature flag)`,
        };
      }
    }

    const bundled = catalog.find(
      (s) => s.id === spec.slug && s.source === "bundled",
    );
    if (bundled) {
      // Intentional divergence from postInstallSkill(): bundled skills are
      // shipped with the assistant binary and are already on disk. They skip
      // SKILLS.md indexing (they're discovered via the bundled catalog, not
      // the workspace index), dependency installation (deps are pre-bundled),
      // and catalog reload (the catalog already includes them). Only
      // auto-enable, broadcast, and seed memories are needed.
      try {
        const raw = loadRawConfig();
        ensureSkillEntry(raw, spec.slug).enabled = true;
        saveConfigWithSuppression(raw, ctx);
        ctx.broadcast({
          type: "skills_state_changed",
          name: spec.slug,
          state: "enabled",
        });
      } catch (err) {
        log.warn(
          { err, skillId: spec.slug },
          "Failed to auto-enable bundled skill",
        );
      }
      seedSkillGraphNodes();
      void seedUninstalledCatalogSkillMemories().catch(() => {});
      return { success: true };
    }

    // Check the Vellum catalog (first-party skills hosted on the platform).
    // Skip when the caller explicitly specified a community origin — this
    // prevents slug collisions where a catalog skill shadows a community
    // skill the user selected from search results.
    if (spec.origin !== "clawhub" && spec.origin !== "skillssh")
      try {
        const vellumCatalog = await getCatalog();
        const catalogEntry = vellumCatalog.find((s) => s.id === spec.slug);
        if (catalogEntry) {
          await installSkillLocally(
            spec.slug,
            catalogEntry,
            true,
            spec.contactId,
          );

          const skillDir = join(getWorkspaceSkillsDir(), spec.slug);
          postInstallSkill(spec.slug, skillDir, ctx);
          return { success: true };
        }
      } catch (err) {
        // If catalog lookup/install fails, fall through to community registries
        log.warn(
          { err, skillId: spec.slug },
          "Vellum catalog install failed, falling back to community registry",
        );
      }

    // skills.sh install path: route here when origin is explicitly "skillssh"
    // or when the slug looks like a skills.sh multi-segment format (owner/repo/skill)
    if (
      spec.origin === "skillssh" ||
      (spec.origin !== "clawhub" && looksLikeSkillsShSlug(spec.slug))
    ) {
      const resolved = resolveSkillSource(spec.slug);
      await installExternalSkill(
        resolved.owner,
        resolved.repo,
        resolved.skillSlug,
        true /* overwrite */,
        resolved.ref ?? spec.version,
        spec.contactId,
      );

      const skillDir = join(getWorkspaceSkillsDir(), resolved.skillSlug);
      postInstallSkill(resolved.skillSlug, skillDir, ctx);
      return { success: true };
    }

    // Install from clawhub (community)
    const result = await clawhubInstall(spec.slug, {
      version: spec.version,
      contactId: spec.contactId,
    });
    if (!result.success) {
      return { success: false, error: result.error ?? "Unknown error" };
    }
    const rawId = result.skillName ?? spec.slug;
    const skillId = rawId.includes("/") ? rawId.split("/").pop()! : rawId;

    // clawhubInstall uses the clawhub CLI which doesn't handle bun install
    // or SKILLS.md indexing, so we do those here before post-install.
    const skillDir = join(getWorkspaceSkillsDir(), skillId);
    if (existsSync(join(skillDir, "package.json"))) {
      const bunPath = `${homedir()}/.bun/bin`;
      execSync("bun install", {
        cwd: skillDir,
        stdio: "inherit",
        env: { ...process.env, PATH: `${bunPath}:${process.env.PATH}` },
      });
    }
    upsertSkillsIndex(skillId);

    postInstallSkill(skillId, skillDir, ctx);
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to install skill");
    return { success: false, error: message };
  }
}

export async function uninstallSkill(
  skillId: string,
  ctx: SkillOperationContext,
): Promise<{ success: true } | { success: false; error: string }> {
  // Validate skill name to prevent path traversal while allowing namespaced slugs (org/name)
  const validNamespacedSlug =
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
  const validSimpleName = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
  if (
    skillId.includes("..") ||
    skillId.includes("\\") ||
    !(validSimpleName.test(skillId) || validNamespacedSlug.test(skillId))
  ) {
    return { success: false, error: "Invalid skill name" };
  }

  try {
    // Use shared managed-store logic for simple managed skill IDs
    const isManagedId = !validateManagedSkillId(skillId);
    if (isManagedId) {
      const result = deleteManagedSkill(skillId);
      if (!result.deleted) {
        return {
          success: false,
          error: result.error ?? "Failed to delete managed skill",
        };
      }
    } else {
      // Namespaced slug (org/name) — direct filesystem removal
      const skillDir = join(getWorkspaceSkillsDir(), skillId);
      if (!existsSync(skillDir)) {
        return { success: false, error: "Skill not found" };
      }
      rmSync(skillDir, { recursive: true });
      try {
        removeSkillsIndexEntry(skillId);
      } catch {
        /* best effort */
      }
      // Best-effort cleanup of capability memory for uninstalled skill
      // (managed path handles this internally via deleteManagedSkill)
      deleteSkillCapabilityNode(skillId);
    }

    // Clean config entry
    const raw = loadRawConfig();
    const skills = raw.skills as Record<string, unknown> | undefined;
    const entries = skills?.entries as Record<string, unknown> | undefined;
    if (entries?.[skillId]) {
      delete entries[skillId];
      saveConfigWithSuppression(raw, ctx);
    }

    ctx.broadcast({
      type: "skills_state_changed",
      name: skillId,
      state: "uninstalled",
    });

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to uninstall skill");
    return { success: false, error: message };
  }
}

export async function updateSkill(
  skillId: string,
  _ctx: SkillOperationContext,
): Promise<{ success: true } | { success: false; error: string }> {
  try {
    const result = await clawhubUpdate(skillId);
    if (!result.success) {
      return { success: false, error: result.error ?? "Unknown error" };
    }
    // Reload skill catalog to pick up updated skill
    loadSkillCatalog();
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to update skill");
    return { success: false, error: message };
  }
}

export async function checkSkillUpdates(
  _ctx: SkillOperationContext,
): Promise<
  { success: true; data: unknown } | { success: false; error: string }
> {
  try {
    const updates = await clawhubCheckUpdates();
    return { success: true, data: updates };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to check for skill updates");
    return { success: false, error: message };
  }
}

export async function searchSkills(
  query: string,
  _ctx: SkillOperationContext,
): Promise<
  | { success: true; skills: SlimSkillResponse[] }
  | { success: false; error: string }
> {
  try {
    // Search the loaded skill catalog (bundled + installed) for matches.
    // Use resolveSkillStates + toSlimSkillResponse so that already-installed
    // or bundled skills get their correct kind/origin/status instead of being
    // hard-coded as catalog/available.
    const catalog = loadSkillCatalog();
    const config = getConfig();
    const resolved = resolveSkillStates(catalog, config);
    const resolvedById = new Map(resolved.map((r) => [r.summary.id, r]));

    const catalogMatches = filterByQuery(catalog, query, [
      (s) => s.id,
      (s) => s.displayName,
      (s) => s.description,
    ]);

    const catalogItems: SlimSkillResponse[] = catalogMatches.map((s) => {
      const r = resolvedById.get(s.id);
      if (r) {
        return toSlimSkillResponse(r.summary, r.state);
      }
      // Fallback for catalog entries not in resolvedSkillStates (shouldn't
      // normally happen, but defensive)
      return {
        id: s.id,
        name: s.displayName,
        description: s.description,
        emoji: s.emoji,
        kind: "catalog" as const,
        origin: "vellum" as const,
        status: "available" as const,
      };
    });

    // Search both community registries in parallel (non-fatal on failure)
    const [clawhubResult, skillsshResult] = await Promise.allSettled([
      clawhubSearch(query),
      searchSkillsRegistry(query, 25),
    ]);

    let clawhubSkills: SlimSkillResponse[] = [];
    if (clawhubResult.status === "fulfilled") {
      clawhubSkills = clawhubResult.value.skills.map((s) => ({
        id: s.slug,
        name: s.name,
        description: s.description,
        kind: "catalog" as const,
        origin: "clawhub" as const,
        status: "available" as const,
        slug: s.slug,
        author: s.author,
        stars: s.stars,
        installs: s.installs,
        reports: 0,
        publishedAt: s.createdAt
          ? new Date(s.createdAt * 1000).toISOString()
          : undefined,
      }));
    } else {
      log.warn(
        { err: clawhubResult.reason },
        "clawhub search failed, continuing without clawhub results",
      );
    }

    let skillsshSkills: SlimSkillResponse[] = [];
    if (skillsshResult.status === "fulfilled") {
      skillsshSkills = skillsshResult.value.map((r) => ({
        id: r.id,
        name: r.name,
        description: "",
        kind: "catalog" as const,
        origin: "skillssh" as const,
        status: "available" as const,
        slug: r.id,
        sourceRepo: r.source,
        installs: r.installs,
      }));
    } else {
      log.warn(
        { err: skillsshResult.reason },
        "skills.sh search failed, continuing without skills.sh results",
      );
    }

    // Deduplicate: catalog > clawhub > skills.sh (first occurrence wins)
    const seenSlugs = new Set(catalogItems.map((s) => s.id));

    const dedupedClawhub = clawhubSkills.filter((s) => {
      if (seenSlugs.has(s.id)) return false;
      seenSlugs.add(s.id);
      return true;
    });

    const dedupedSkillssh = skillsshSkills.filter((s) => {
      if (seenSlugs.has(s.id)) return false;
      seenSlugs.add(s.id);
      return true;
    });

    return {
      success: true,
      skills: [...catalogItems, ...dedupedClawhub, ...dedupedSkillssh],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to search skills");
    return { success: false, error: message };
  }
}

export async function inspectSkill(
  skillId: string,
  _ctx: SkillOperationContext,
): Promise<{ slug: string; data?: ClawhubInspectResult; error?: string }> {
  try {
    const result = await clawhubInspect(skillId);
    return {
      slug: skillId,
      ...(result.data ? { data: result.data } : {}),
      ...(result.error ? { error: result.error } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to inspect skill");
    return { slug: skillId, error: message };
  }
}

export interface DraftResult {
  success: boolean;
  draft?: {
    skillId: string;
    name: string;
    description: string;
    emoji?: string;
    bodyMarkdown: string;
  };
  warnings?: string[];
  error?: string;
}

export async function draftSkill(
  params: { sourceText: string },
  _ctx: SkillOperationContext,
): Promise<DraftResult> {
  try {
    const warnings: string[] = [];
    const parsed = parseFrontmatter(params.sourceText);
    const body = parsed.body.trim() || params.sourceText.trim();

    let { skillId, name, description, emoji } = parsed;

    // Determine which fields still need filling
    const missing: string[] = [];
    if (!skillId) missing.push("skillId");
    if (!name) missing.push("name");
    if (!description) missing.push("description");
    if (!emoji) missing.push("emoji");

    // Attempt LLM generation for missing fields
    if (missing.length > 0) {
      let llmGenerated = false;
      try {
        const provider = await getConfiguredProvider();
        if (provider) {
          const { signal, cleanup } = createTimeout(LLM_DRAFT_TIMEOUT_MS);
          try {
            const prompt = [
              "Given the following skill body text, generate metadata for a managed skill.",
              `Return ONLY valid JSON with these fields: ${missing.join(", ")}.`,
              "Field descriptions:",
              "- skillId: a short kebab-case identifier (lowercase, alphanumeric + hyphens/dots/underscores, max 50 chars, must start with a letter or digit)",
              "- name: a human-readable name (max 100 chars)",
              "- description: a brief one-line description (max 200 chars)",
              "- emoji: a single emoji character representing the skill",
              "",
              "Skill body:",
              body.slice(0, 2000),
            ].join("\n");

            const response = await provider.sendMessage(
              [userMessage(prompt)],
              [],
              undefined,
              {
                config: { modelIntent: "latency-optimized", max_tokens: 256 },
                signal,
              },
            );
            cleanup();

            const responseText = extractText(response);
            // Extract JSON from response (handle markdown code fences)
            const jsonMatch = /\{[\s\S]*?\}/.exec(responseText);
            if (jsonMatch) {
              const generated = JSON.parse(jsonMatch[0]);
              if (typeof generated === "object" && generated) {
                if (!skillId && typeof generated.skillId === "string")
                  skillId = generated.skillId;
                if (!name && typeof generated.name === "string")
                  name = generated.name;
                if (!description && typeof generated.description === "string")
                  description = generated.description;
                if (!emoji && typeof generated.emoji === "string")
                  emoji = generated.emoji;
                llmGenerated = true;
              }
            }
          } catch (err) {
            cleanup();
            log.warn(
              { err },
              "LLM draft generation failed, falling back to heuristic",
            );
            warnings.push(
              "LLM draft generation failed, used heuristic fallback",
            );
          }
        } else {
          warnings.push("No LLM provider available, used heuristic fallback");
        }
      } catch (err) {
        log.warn({ err }, "Provider resolution failed for draft generation");
        warnings.push("Provider resolution failed, used heuristic fallback");
      }

      // Fall back to heuristic for any fields still missing
      if (!skillId || !name || !description || !emoji) {
        const heuristic = heuristicDraft(body);
        if (!skillId) {
          skillId = heuristic.skillId;
          if (!llmGenerated) warnings.push("skillId derived from heuristic");
        }
        if (!name) {
          name = heuristic.name;
          if (!llmGenerated) warnings.push("name derived from heuristic");
        }
        if (!description) {
          description = heuristic.description;
          if (!llmGenerated)
            warnings.push("description derived from heuristic");
        }
        if (!emoji) {
          emoji = heuristic.emoji;
        }
      }
    }

    // Normalize skillId to valid managed-skill slug format
    const originalId = skillId!;
    skillId = toSkillSlug(originalId);
    if (!skillId) skillId = "untitled-skill";
    if (skillId !== originalId) {
      warnings.push(`skillId normalized from "${originalId}" to "${skillId}"`);
    }

    // Final validation pass
    const validationError = validateManagedSkillId(skillId);
    if (validationError) {
      skillId =
        toSkillSlug(skillId.replace(/[^a-z0-9]/g, "-")) || "untitled-skill";
      warnings.push(
        `skillId re-normalized due to validation: ${validationError}`,
      );
    }

    return {
      success: true,
      draft: {
        skillId: skillId!,
        name: name!,
        description: description!,
        emoji,
        bodyMarkdown: body,
      },
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to generate skill draft");
    return { success: false, error: message };
  }
}

export interface CreateSkillParams {
  skillId: string;
  name: string;
  description: string;
  emoji?: string;
  bodyMarkdown: string;
  overwrite?: boolean;
  contactId?: string;
}

export async function createSkill(
  params: CreateSkillParams,
  ctx: SkillOperationContext,
): Promise<{ success: true } | { success: false; error: string }> {
  try {
    const result = createManagedSkill({
      id: params.skillId,
      name: params.name,
      description: params.description,
      emoji: params.emoji,
      bodyMarkdown: params.bodyMarkdown,
      overwrite: params.overwrite,
      contactId: params.contactId,
    });

    if (!result.created) {
      return {
        success: false,
        error: result.error ?? "Failed to create managed skill",
      };
    }

    // Auto-enable the newly created skill
    try {
      const raw = loadRawConfig();
      ensureSkillEntry(raw, params.skillId).enabled = true;
      saveConfigWithSuppression(raw, ctx);
      ctx.broadcast({
        type: "skills_state_changed",
        name: params.skillId,
        state: "enabled",
      });
    } catch (err) {
      log.warn(
        { err, skillId: params.skillId },
        "Failed to auto-enable created skill",
      );
    }

    seedSkillGraphNodes();
    void seedUninstalledCatalogSkillMemories().catch(() => {});
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to create skill");
    return { success: false, error: message };
  }
}

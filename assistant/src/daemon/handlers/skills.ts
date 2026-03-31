import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, relative } from "node:path";

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
  createTimeout,
  extractText,
  getConfiguredProvider,
  userMessage,
} from "../../providers/provider-send-message.js";
import { isTextMimeType as isTextMime } from "../../runtime/routes/workspace-utils.js";
import { getCatalog } from "../../skills/catalog-cache.js";
import { installSkillLocally } from "../../skills/catalog-install.js";
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
  createManagedSkill,
  deleteManagedSkill,
  removeSkillsIndexEntry,
  validateManagedSkillId,
} from "../../skills/managed-store.js";
import {
  deleteSkillCapabilityMemory,
  seedCatalogSkillMemories,
} from "../../skills/skill-memory.js";
import { getWorkspaceSkillsDir } from "../../util/platform.js";
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

// ─── Provenance resolution ──────────────────────────────────────────────────

interface SkillProvenance {
  kind: "first-party" | "third-party" | "local";
  provider?: string;
  originId?: string;
  sourceUrl?: string;
}

const CLAWHUB_BASE_URL = "https://skills.sh";

function resolveProvenance(summary: SkillSummary): SkillProvenance {
  // Bundled skills are always first-party (shipped with Vellum)
  if (summary.source === "bundled") {
    return { kind: "first-party", provider: "Vellum" };
  }

  // Managed skills are third-party (installed from clawhub). The homepage field
  // confirms provenance.
  if (summary.source === "managed") {
    if (
      summary.homepage?.includes("skills.sh") ||
      summary.homepage?.includes("clawhub")
    ) {
      return {
        kind: "third-party",
        provider: "skills.sh",
        originId: summary.id,
        sourceUrl:
          summary.homepage ??
          `${CLAWHUB_BASE_URL}/skills/${encodeURIComponent(summary.id)}`,
      };
    }
    // No positive evidence of clawhub origin -- likely user-authored.
    // Default to "local" to avoid mislabeling.
    return { kind: "local" };
  }

  // Workspace and extra skills are user-provided
  if (summary.source === "workspace" || summary.source === "extra") {
    return { kind: "local" };
  }

  return { kind: "local" };
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

export interface SkillListItem {
  id: string;
  name: string;
  description: string;
  emoji?: string;
  homepage?: string;
  source: "bundled" | "managed" | "workspace" | "clawhub" | "extra" | "catalog";
  state: "enabled" | "disabled";
  installStatus: "bundled" | "installed" | "available";
  updateAvailable: boolean;
  provenance: SkillProvenance;
}

/** Sorting rank for provenance-based ordering: first-party first, local last. */
function provenanceSortRank(p: SkillProvenance): number {
  if (p.kind === "first-party") return 0;
  if (p.kind === "third-party" && p.provider) return 1;
  if (p.kind === "third-party") return 2;
  return 3; // local
}

export function listSkills(_ctx: SkillOperationContext): SkillListItem[] {
  const config = getConfig();
  const catalog = loadSkillCatalog();
  const resolved = resolveSkillStates(catalog, config);

  const items = resolved.map((r) => ({
    id: r.summary.id,
    name: r.summary.displayName,
    description: r.summary.description,
    emoji: r.summary.emoji,
    homepage: r.summary.homepage,
    source: r.summary.source,
    state: r.state,
    installStatus: (r.summary.source === "bundled"
      ? "bundled"
      : "installed") as SkillListItem["installStatus"],
    updateAvailable: false,
    provenance: resolveProvenance(r.summary),
  }));

  // Sort: first-party > third-party with provider > third-party without > local,
  // alphabetical by name within each tier.
  items.sort((a, b) => {
    const rankDiff =
      provenanceSortRank(a.provenance) - provenanceSortRank(b.provenance);
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
): Promise<SkillListItem[]> {
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
  // Create SkillListItems for catalog skills not already installed.
  const available: SkillListItem[] = catalogSkills
    .filter((cs) => !installedIds.has(cs.id))
    .map((cs) => ({
      id: cs.id,
      name: cs.metadata?.vellum?.["display-name"] ?? cs.name,
      description: cs.description,
      emoji: cs.emoji,
      homepage: undefined,
      source: "catalog" as const,
      state: "disabled" as const,
      installStatus: "available" as const,
      updateAvailable: false,
      provenance: { kind: "first-party" as const, provider: "Vellum" },
    }));

  const merged = [...installed, ...available];

  // Sort using the same provenance sort + alphabetical
  merged.sort((a, b) => {
    const rankDiff =
      provenanceSortRank(a.provenance) - provenanceSortRank(b.provenance);
    if (rankDiff !== 0) return rankDiff;
    return a.name.localeCompare(b.name);
  });

  return merged;
}

/** Look up a single skill by ID from the resolved catalog, returning its SkillListItem. */
function findSkillById(
  skillId: string,
): { item: SkillListItem; summary: SkillSummary } | undefined {
  const config = getConfig();
  const catalog = loadSkillCatalog();
  const resolved = resolveSkillStates(catalog, config);
  const match = resolved.find((r) => r.summary.id === skillId);
  if (!match) return undefined;

  const r = match;
  const item: SkillListItem = {
    id: r.summary.id,
    name: r.summary.displayName,
    description: r.summary.description,
    emoji: r.summary.emoji,
    homepage: r.summary.homepage,
    source: r.summary.source,
    state: r.state,
    installStatus: r.summary.source === "bundled" ? "bundled" : "installed",
    updateAvailable: false,
    provenance: resolveProvenance(r.summary),
  };
  return { item, summary: r.summary };
}

export function getSkill(
  skillId: string,
  _ctx: SkillOperationContext,
): { skill: SkillListItem } | { error: string; status: number } {
  const found = findSkillById(skillId);
  if (!found) {
    return { error: `Skill "${skillId}" not found`, status: 404 };
  }
  return { skill: found.item };
}

// ─── Skill file listing ──────────────────────────────────────────────────────

export interface SkillFileEntry {
  path: string; // relative to skill directory root (e.g. "SKILL.md", "tools/foo.ts")
  name: string; // basename
  size: number;
  mimeType: string;
  isBinary: boolean;
  content: string | null; // inline text if ≤ 2 MB and text MIME, else null
}

const SKIP_DIRS = new Set(["node_modules", "__pycache__", ".git"]);

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

export function getSkillFiles(
  skillId: string,
  _ctx: SkillOperationContext,
):
  | { skill: SkillListItem; files: SkillFileEntry[] }
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
    seedCatalogSkillMemories();
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

export async function installSkill(
  spec: { slug: string; version?: string },
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
      // Auto-enable the bundled skill so it's immediately usable
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
      seedCatalogSkillMemories();
      return { success: true };
    }

    // Check the Vellum catalog (first-party skills hosted on the platform)
    try {
      const vellumCatalog = await getCatalog();
      const catalogEntry = vellumCatalog.find((s) => s.id === spec.slug);
      if (catalogEntry) {
        await installSkillLocally(spec.slug, catalogEntry, true);

        // Reload skill catalog so the newly installed skill is picked up
        loadSkillCatalog();

        // Auto-enable the newly installed catalog skill
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
            "Failed to auto-enable installed catalog skill",
          );
        }

        seedCatalogSkillMemories();
        return { success: true };
      }
    } catch (err) {
      // If catalog lookup/install fails, fall through to clawhub
      log.warn(
        { err, skillId: spec.slug },
        "Vellum catalog install failed, falling back to community registry",
      );
    }

    // Install from clawhub (community)
    const result = await clawhubInstall(spec.slug, { version: spec.version });
    if (!result.success) {
      return { success: false, error: result.error ?? "Unknown error" };
    }
    const rawId = result.skillName ?? spec.slug;
    const skillId = rawId.includes("/") ? rawId.split("/").pop()! : rawId;

    // Reload skill catalog so the newly installed skill is picked up
    loadSkillCatalog();

    // Auto-enable the newly installed skill
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

    seedCatalogSkillMemories();
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
      deleteSkillCapabilityMemory(skillId);
      try {
        const { deleteSkillCapabilityNode } =
          await import("../../memory/graph/capability-seed.js");
        deleteSkillCapabilityNode(skillId);
      } catch {
        /* best effort */
      }
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
  { success: true; data: unknown } | { success: false; error: string }
> {
  try {
    // Search the loaded skill catalog (bundled + installed) for matches
    const catalog = loadSkillCatalog();
    const catalogMatches = filterByQuery(catalog, query, [
      (s) => s.id,
      (s) => s.displayName,
      (s) => s.description,
    ]);

    // Shape that matches ClawhubSearchResultItem so the client
    // (Swift ClawhubSkillItem) can decode results uniformly.
    interface SearchItem {
      name: string;
      slug: string;
      description: string;
      author: string;
      stars: number;
      installs: number;
      version: string;
      createdAt: number;
      source: "vellum" | "clawhub";
    }

    const catalogItems: SearchItem[] = catalogMatches.map((s) => ({
      name: s.displayName,
      slug: s.id,
      description: s.description,
      author: "Vellum",
      stars: 0,
      installs: 0,
      version: "",
      createdAt: 0,
      source: "vellum" as const,
    }));

    // Search the community registry (non-fatal on failure)
    let communitySkills: SearchItem[] = [];
    try {
      const communityResult = await clawhubSearch(query);
      communitySkills = communityResult.skills;
    } catch (err) {
      log.warn(
        { err },
        "clawhub search failed, returning catalog-only results",
      );
    }

    // Deduplicate: catalog takes precedence when slugs collide
    const catalogSlugs = new Set(catalogItems.map((s) => s.slug));
    const deduped = communitySkills.filter((s) => !catalogSlugs.has(s.slug));

    return {
      success: true,
      data: { skills: [...catalogItems, ...deduped] },
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

    seedCatalogSkillMemories();
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, "Failed to create skill");
    return { success: false, error: message };
  }
}

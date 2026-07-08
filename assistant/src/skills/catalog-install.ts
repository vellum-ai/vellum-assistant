import { execSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";

import { getPlatformBaseUrl } from "../config/env.js";
import { loadSkillCatalog } from "../config/skills.js";
import { getLogger } from "../util/logger.js";
import { getWorkspaceSkillsDir } from "../util/platform.js";
import { computeSkillHash, writeInstallMeta } from "./install-meta.js";

const log = getLogger("catalog-install");

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CatalogSkill {
  id: string;
  name: string;
  description: string;
  icon?: string;
  emoji?: string;
  includes?: string[];
  version?: string;
  updatedAt?: string;
  metadata?: {
    icon?: string;
    emoji?: string;
    vellum?: {
      "display-name"?: string;
      "activation-hints"?: string[];
      "avoid-when"?: string[];
      "feature-flag"?: string;
      category?: string;
    };
  };
}

/**
 * Resolve the directory containing a `catalog.json` and first-party skill
 * sources — either bundled next to a compiled binary (e.g. `Vellum.app`) or
 * in the dev repo.
 *
 * Both `getCatalog()` in `catalog-cache.ts` and `resolveCatalog()` below
 * merge the local catalog with the remote one so skills published after a
 * release still show up; the local catalog is used as an offline fallback
 * when the remote fetch fails.
 */
export function getRepoSkillsDir(): string | undefined {
  const importDir = import.meta.dir;

  if (importDir.startsWith("/$bunfs/")) {
    const execDir = dirname(process.execPath);
    // macOS .app bundle: binary in Contents/MacOS/, resources in Contents/Resources/
    const resourcesPath = join(
      execDir,
      "..",
      "Resources",
      "first-party-skills",
    );
    if (existsSync(join(resourcesPath, "catalog.json"))) {
      return resourcesPath;
    }
    // Next to the binary (non-app-bundle compiled deployments)
    const execDirPath = join(execDir, "first-party-skills");
    if (existsSync(join(execDirPath, "catalog.json"))) {
      return execDirPath;
    }
    return undefined;
  }

  if (!process.env.VELLUM_DEV) return undefined;

  // assistant/src/skills/catalog-install.ts -> ../../../skills/
  const candidate = join(importDir, "..", "..", "..", "skills");
  if (existsSync(join(candidate, "catalog.json"))) {
    return candidate;
  }
  return undefined;
}

// ─── Catalog operations ──────────────────────────────────────────────────────

/**
 * Raw skill entry as returned by the platform `/v1/skills/` API. The platform
 * serializer flattens the skill's metadata into top-level fields
 * (`category`, `display_name`, `icon`) rather than the nested
 * `metadata.vellum.*` shape used by the local `catalog.json`. Both shapes are
 * accepted here so the daemon has a single canonical representation downstream.
 */
interface RawCatalogEntry {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  icon?: unknown;
  emoji?: string;
  includes?: string[];
  version?: string;
  updatedAt?: unknown;
  display_name?: unknown;
  category?: unknown;
  updated_at?: unknown;
  metadata?: CatalogSkill["metadata"];
}

function asStr(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Normalize a platform API entry into a canonical {@link CatalogSkill}.
 *
 * The platform flattens `category`, `display_name`, and `icon` to the top
 * level, so re-nest them under `metadata.vellum` to match the local catalog
 * shape that the rest of the daemon reads (`metadata.vellum.category`,
 * `metadata.vellum["display-name"]`). Existing nested values take precedence
 * so a future API change to the nested shape keeps working.
 */
function normalizeCatalogEntry(raw: unknown): CatalogSkill | null {
  if (typeof raw !== "object" || raw === null) return null;
  const entry = raw as RawCatalogEntry;

  const id = asStr(entry.id);
  if (!id) return null;

  const nested = entry.metadata?.vellum;
  const category = nested?.category ?? asStr(entry.category);
  const displayName = nested?.["display-name"] ?? asStr(entry.display_name);
  const icon = asStr(entry.icon) ?? asStr(entry.metadata?.icon);
  const updatedAt = asStr(entry.updatedAt) ?? asStr(entry.updated_at);

  return {
    id,
    name: asStr(entry.name) ?? id,
    description: asStr(entry.description) ?? "",
    ...(icon ? { icon } : {}),
    ...(entry.emoji ? { emoji: entry.emoji } : {}),
    ...(entry.includes ? { includes: entry.includes } : {}),
    ...(entry.version ? { version: entry.version } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    metadata: {
      ...entry.metadata,
      ...(icon ? { icon } : {}),
      vellum: {
        ...nested,
        ...(displayName ? { "display-name": displayName } : {}),
        ...(category ? { category } : {}),
      },
    },
  };
}

export async function fetchCatalog(): Promise<CatalogSkill[]> {
  const platformUrl = getPlatformBaseUrl();
  const url = `${platformUrl}/v1/skills/`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(
      `Platform API error ${response.status}: ${response.statusText}`,
    );
  }

  const manifest = (await response.json()) as { skills?: unknown };
  if (!Array.isArray(manifest.skills)) {
    throw new Error("Platform catalog has invalid skills array");
  }
  return manifest.skills
    .map((s) => normalizeCatalogEntry(s))
    .filter((s): s is CatalogSkill => s !== null);
}

export function readLocalCatalog(repoSkillsDir: string): CatalogSkill[] {
  try {
    const raw = readFileSync(join(repoSkillsDir, "catalog.json"), "utf-8");
    const manifest = JSON.parse(raw) as { skills?: unknown };
    if (!Array.isArray(manifest.skills)) return [];
    return manifest.skills
      .map((s) => normalizeCatalogEntry(s))
      .filter((s): s is CatalogSkill => s !== null);
  } catch {
    return [];
  }
}

// ─── Tar extraction ──────────────────────────────────────────────────────────

interface SafeSkillInstallPath {
  normalizedPath: string;
  destPath: string;
}

function safeResolveSkillInstallPath(
  destRoot: string,
  relativePath: string,
): SafeSkillInstallPath | null {
  const normalizedName = relativePath.replace(/\\/g, "/").replace(/^\.\/+/, "");
  const normalizedPath = posix.normalize(normalizedName);
  const hasWindowsDrivePrefix = /^[a-zA-Z]:\//.test(normalizedPath);
  const isTraversal =
    normalizedPath === ".." || normalizedPath.startsWith("../");

  if (
    !normalizedPath ||
    normalizedPath === "." ||
    normalizedPath.startsWith("/") ||
    hasWindowsDrivePrefix ||
    isTraversal
  ) {
    return null;
  }

  const resolvedDestRoot = resolve(destRoot);
  const destPath = resolve(resolvedDestRoot, normalizedPath);
  const insideDestination =
    destPath === resolvedDestRoot ||
    destPath.startsWith(resolvedDestRoot + sep);
  if (!insideDestination) return null;

  return { normalizedPath, destPath };
}

export function writeSkillFilesToDir(
  files: Record<string, string | Buffer>,
  destDir: string,
): boolean {
  let foundSkillMd = false;
  for (const [relativePath, content] of Object.entries(files)) {
    const resolved = safeResolveSkillInstallPath(destDir, relativePath);
    if (!resolved) continue;

    mkdirSync(dirname(resolved.destPath), { recursive: true });
    writeFileSync(resolved.destPath, content);

    if (resolved.normalizedPath === "SKILL.md") {
      foundSkillMd = true;
    }
  }
  return foundSkillMd;
}

/**
 * Extract all files from a tar archive (uncompressed) into a directory.
 * Returns true if a top-level SKILL.md was found in the archive.
 */
export function extractTarToDir(tarBuffer: Buffer, destDir: string): boolean {
  let foundSkillMd = false;
  let offset = 0;
  while (offset + 512 <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + 512);

    // End-of-archive (two consecutive zero blocks)
    if (header.every((b) => b === 0)) break;

    // Filename (bytes 0-99, null-terminated)
    const nameEnd = header.indexOf(0, 0);
    const name = header
      .subarray(0, Math.min(nameEnd >= 0 ? nameEnd : 100, 100))
      .toString("utf-8");

    // File type (byte 156): '5' = directory, '0' or '\0' = regular file
    const typeFlag = header[156];

    // File size (bytes 124-135, octal)
    const sizeStr = header.subarray(124, 136).toString("utf-8").trim();
    const size = parseInt(sizeStr, 8) || 0;

    offset += 512; // past header

    // Skip directories and empty names
    if (name && typeFlag !== 53 /* '5' */) {
      const resolved = safeResolveSkillInstallPath(destDir, name);
      if (resolved) {
        mkdirSync(dirname(resolved.destPath), { recursive: true });
        writeFileSync(
          resolved.destPath,
          tarBuffer.subarray(offset, offset + size),
        );

        if (resolved.normalizedPath === "SKILL.md") foundSkillMd = true;
      }
    }

    // Skip to next header (data padded to 512 bytes)
    offset += Math.ceil(size / 512) * 512;
  }
  return foundSkillMd;
}

async function fetchAndExtractSkill(
  skillId: string,
  destDir: string,
): Promise<void> {
  const platformUrl = getPlatformBaseUrl();
  const url = `${platformUrl}/v1/skills/${encodeURIComponent(skillId)}/`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch skill "${skillId}": HTTP ${response.status}`,
    );
  }

  const gzipBuffer = Buffer.from(await response.arrayBuffer());
  const tarBuffer = gunzipSync(gzipBuffer);
  const foundSkillMd = extractTarToDir(tarBuffer, destDir);

  if (!foundSkillMd) {
    throw new Error(`SKILL.md not found in archive for "${skillId}"`);
  }
}

function assertInstalledSkillDiscoverable(
  skillId: string,
  skillDir = join(getWorkspaceSkillsDir(), skillId),
): void {
  const skillFilePath = join(skillDir, "SKILL.md");
  if (!existsSync(skillFilePath)) {
    throw new Error(
      `Installed skill "${skillId}" is missing SKILL.md at the skill root`,
    );
  }

  const discovered = loadSkillCatalog().some((skill) => {
    if (skill.id !== skillId) return false;
    try {
      return realpathSync(skill.directoryPath) === realpathSync(skillDir);
    } catch {
      return skill.directoryPath === skillDir;
    }
  });
  if (!discovered) {
    throw new Error(
      `Installed skill "${skillId}" was not discovered by the skill catalog`,
    );
  }
}

function getInstallStagingRoot(): string {
  return join(getWorkspaceSkillsDir(), ".install-staging");
}

export function createSkillInstallStagingDir(): string {
  const stagingRoot = getInstallStagingRoot();
  mkdirSync(stagingRoot, { recursive: true });
  return mkdtempSync(join(stagingRoot, "skill-"));
}

function createSkillInstallBackupPath(): string {
  const stagingRoot = getInstallStagingRoot();
  mkdirSync(stagingRoot, { recursive: true });
  return join(
    stagingRoot,
    `backup-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
}

function assertStagedSkillRoot(skillId: string, stagedDir: string): void {
  if (!existsSync(join(stagedDir, "SKILL.md"))) {
    throw new Error(
      `Installed skill "${skillId}" is missing SKILL.md at the skill root`,
    );
  }
}

export function installSkillDependenciesIfPresent(skillDir: string): void {
  if (existsSync(join(skillDir, "package.json"))) {
    const bunPath = `${homedir()}/.bun/bin`;
    execSync("bun install", {
      cwd: skillDir,
      stdio: "inherit",
      env: { ...process.env, PATH: `${bunPath}:${process.env.PATH}` },
    });
  }
}

function restoreOrRemoveFailedSkillInstall(
  skillId: string,
  backupDir: string | null,
): void {
  const skillDir = join(getWorkspaceSkillsDir(), skillId);
  rmSync(skillDir, { recursive: true, force: true });
  if (backupDir) {
    renameSync(backupDir, skillDir);
  }
}

function discardSkillInstallBackup(backupDir: string | null): void {
  if (backupDir) {
    rmSync(backupDir, { recursive: true, force: true });
  }
}

function snapshotExistingSkillDir(skillId: string): string | null {
  const skillDir = join(getWorkspaceSkillsDir(), skillId);
  if (!existsSync(skillDir)) return null;

  const backupDir = createSkillInstallBackupPath();
  renameSync(skillDir, backupDir);
  return backupDir;
}

export function commitStagedSkillInstall(
  skillId: string,
  stagedDir: string,
): void {
  assertStagedSkillRoot(skillId, stagedDir);

  const skillDir = join(getWorkspaceSkillsDir(), skillId);
  let backupDir: string | null = null;
  let stagedMovedToFinal = false;

  try {
    backupDir = snapshotExistingSkillDir(skillId);
    renameSync(stagedDir, skillDir);
    stagedMovedToFinal = true;
    assertInstalledSkillDiscoverable(skillId, skillDir);
    discardSkillInstallBackup(backupDir);
  } catch (err) {
    const originalMessage = err instanceof Error ? err.message : String(err);
    let restoreError: unknown;
    if (backupDir || stagedMovedToFinal) {
      try {
        restoreOrRemoveFailedSkillInstall(skillId, backupDir);
      } catch (restoreErr) {
        restoreError = restoreErr;
      }
    }
    rmSync(stagedDir, { recursive: true, force: true });
    if (restoreError) {
      const restoreMessage =
        restoreError instanceof Error
          ? restoreError.message
          : String(restoreError);
      throw new Error(
        `${originalMessage}; failed to restore previous skill: ${restoreMessage}`,
      );
    }
    throw err;
  }
}

export async function installSkillLocally(
  skillId: string,
  catalogEntry: CatalogSkill,
  overwrite: boolean,
  contactId?: string,
): Promise<void> {
  const skillDir = join(getWorkspaceSkillsDir(), skillId);
  const skillFilePath = join(skillDir, "SKILL.md");

  if (existsSync(skillFilePath) && !overwrite) {
    throw new Error(
      `Skill "${skillId}" is already installed. Use --overwrite to replace it.`,
    );
  }

  const stagedDir = createSkillInstallStagingDir();

  // In dev mode, install from the local repo skills directory if available
  const repoSkillsDir = getRepoSkillsDir();
  const repoSkillSource = repoSkillsDir
    ? join(repoSkillsDir, skillId)
    : undefined;

  let installSource: "repo" | "platform";
  try {
    if (repoSkillSource && existsSync(join(repoSkillSource, "SKILL.md"))) {
      installSource = "repo";
      cpSync(repoSkillSource, stagedDir, { recursive: true });
    } else {
      installSource = "platform";
      await fetchAndExtractSkill(skillId, stagedDir);
    }

    assertStagedSkillRoot(skillId, stagedDir);

    writeInstallMeta(stagedDir, {
      origin: "vellum",
      installedAt: new Date().toISOString(),
      ...(catalogEntry.version ? { version: catalogEntry.version } : {}),
      ...(contactId ? { installedBy: contactId } : {}),
      author: "user",
      contentHash: computeSkillHash(stagedDir) ?? undefined,
    });

    installSkillDependenciesIfPresent(stagedDir);
    commitStagedSkillInstall(skillId, stagedDir);

    log.info(
      { skillId, source: installSource },
      "Installed skill from %s",
      installSource,
    );
  } catch (err) {
    rmSync(stagedDir, { recursive: true, force: true });
    throw err;
  }
}

// ─── Auto-install (for skill_load) ──────────────────────────────────────────

/**
 * Resolve the catalog skill list, checking local (dev mode) first, then remote.
 *
 * In dev mode with a local catalog, returns local entries immediately to avoid
 * unnecessary network latency.  Pass `skillId` to trigger a deferred remote
 * fetch only when the requested skill is not found locally — this preserves the
 * ability to discover remote-only skills without penalising every call with a
 * 10s timeout on flaky networks.
 *
 * Callers that install multiple skills in a loop should call this once and pass
 * the result to `autoInstallFromCatalog` to avoid redundant network requests.
 */
export async function resolveCatalog(
  skillId?: string,
): Promise<CatalogSkill[]> {
  const repoSkillsDir = getRepoSkillsDir();
  if (repoSkillsDir) {
    const local = readLocalCatalog(repoSkillsDir);
    if (local.length > 0) {
      // If no specific skill requested, or it exists locally, skip remote fetch
      if (!skillId || local.some((s) => s.id === skillId)) {
        log.info(
          { skillId, source: "local", count: local.length },
          "Resolved skills catalog from local repo",
        );
        return local;
      }
      // Skill not found locally — merge with remote so remote-only skills
      // can still be discovered. Local entries take precedence by id.
      try {
        const remote = await fetchCatalog();
        const localIds = new Set(local.map((s) => s.id));
        const merged = [...local, ...remote.filter((s) => !localIds.has(s.id))];
        log.info(
          {
            skillId,
            source: "merged",
            localCount: local.length,
            remoteCount: remote.length,
          },
          "Resolved skills catalog from local+remote merge",
        );
        return merged;
      } catch {
        log.info(
          { skillId, source: "local-fallback", count: local.length },
          "Resolved skills catalog from local repo (remote fetch failed)",
        );
        return local;
      }
    }
  }

  log.info(
    { skillId, source: "remote" },
    "Resolved skills catalog from platform API",
  );
  return fetchCatalog();
}

/**
 * Attempt to find and install a skill from the first-party catalog.
 * Returns true if the skill was installed, false if not found in catalog.
 * Throws on install failures (network, filesystem, etc).
 *
 * When `catalog` is provided it is used directly, avoiding a redundant
 * network fetch — pass a pre-resolved catalog when calling in a loop.
 */
export async function autoInstallFromCatalog(
  skillId: string,
  catalog?: CatalogSkill[],
): Promise<boolean> {
  let skills: CatalogSkill[];

  if (catalog) {
    skills = catalog;
  } else {
    try {
      skills = await resolveCatalog(skillId);
    } catch (err) {
      log.warn(
        { err, skillId },
        "Failed to fetch remote catalog for auto-install",
      );
      return false;
    }
  }

  const entry = skills.find((s) => s.id === skillId);
  if (!entry) {
    return false;
  }

  // If the skill already exists on disk, reuse it instead of attempting a
  // fresh install that would fail.
  const skillDir = join(getWorkspaceSkillsDir(), skillId);
  if (existsSync(join(skillDir, "SKILL.md"))) {
    log.info({ skillId, source: "disk" }, "Skill already on disk");
    return true;
  }

  await installSkillLocally(skillId, entry, false);

  return true;
}

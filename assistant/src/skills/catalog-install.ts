import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";

import { getLogger } from "../util/logger.js";
import {
  getWorkspaceConfigPath,
  getWorkspaceSkillsDir,
  readPlatformToken,
} from "../util/platform.js";

const log = getLogger("catalog-install");

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CatalogSkill {
  id: string;
  name: string;
  description: string;
  emoji?: string;
  includes?: string[];
  version?: string;
  metadata?: {
    vellum?: {
      "display-name"?: string;
      "activation-hints"?: string[];
      "avoid-when"?: string[];
      "feature-flag"?: string;
    };
  };
}

export interface CatalogManifest {
  version: number;
  skills: CatalogSkill[];
}

// ─── Path helpers ────────────────────────────────────────────────────────────

export function getSkillsIndexPath(): string {
  return join(getWorkspaceSkillsDir(), "SKILLS.md");
}

/**
 * Resolve the repo-level skills/ directory when running in dev mode.
 * Returns the path if VELLUM_DEV is set and the directory exists, or undefined.
 */
export function getRepoSkillsDir(): string | undefined {
  if (!process.env.VELLUM_DEV) return undefined;

  // assistant/src/skills/catalog-install.ts -> ../../../skills/
  const candidate = join(import.meta.dir, "..", "..", "..", "skills");
  if (existsSync(join(candidate, "catalog.json"))) {
    return candidate;
  }
  return undefined;
}

// ─── Platform API ────────────────────────────────────────────────────────────

function getConfigPlatformUrl(): string | undefined {
  try {
    const configPath = getWorkspaceConfigPath();
    if (!existsSync(configPath)) return undefined;
    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as Record<
      string,
      unknown
    >;
    const platform = raw.platform as Record<string, unknown> | undefined;
    const baseUrl = platform?.baseUrl;
    if (typeof baseUrl === "string" && baseUrl.trim()) return baseUrl.trim();
  } catch {
    // ignore
  }
  return undefined;
}

function getPlatformUrl(): string {
  return (
    process.env.VELLUM_PLATFORM_URL ??
    getConfigPlatformUrl() ??
    "https://platform.vellum.ai"
  );
}

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const token = readPlatformToken();
  if (token) {
    headers["X-Conversation-Token"] = token;
  }
  return headers;
}

// ─── Catalog operations ──────────────────────────────────────────────────────

export async function fetchCatalog(): Promise<CatalogSkill[]> {
  const url = `${getPlatformUrl()}/v1/skills/`;
  const response = await fetch(url, {
    headers: buildHeaders(),
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(
      `Platform API error ${response.status}: ${response.statusText}`,
    );
  }

  const manifest = (await response.json()) as CatalogManifest;
  if (!Array.isArray(manifest.skills)) {
    throw new Error("Platform catalog has invalid skills array");
  }
  return manifest.skills;
}

export function readLocalCatalog(repoSkillsDir: string): CatalogSkill[] {
  try {
    const raw = readFileSync(join(repoSkillsDir, "catalog.json"), "utf-8");
    const manifest = JSON.parse(raw) as CatalogManifest;
    if (!Array.isArray(manifest.skills)) return [];
    return manifest.skills;
  } catch {
    return [];
  }
}

// ─── Tar extraction ──────────────────────────────────────────────────────────

/**
 * Extract all files from a tar archive (uncompressed) into a directory.
 * Returns true if a SKILL.md was found in the archive.
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
      // Prevent path traversal and absolute path writes
      const normalizedName = name.replace(/\\/g, "/").replace(/^\.\/+/, "");
      const normalizedPath = posix.normalize(normalizedName);
      const hasWindowsDrivePrefix = /^[a-zA-Z]:\//.test(normalizedPath);
      const isTraversal =
        normalizedPath === ".." || normalizedPath.startsWith("../");

      if (
        normalizedPath &&
        normalizedPath !== "." &&
        !normalizedPath.startsWith("/") &&
        !hasWindowsDrivePrefix &&
        !isTraversal
      ) {
        const destRoot = resolve(destDir);
        const destPath = resolve(destRoot, normalizedPath);
        const insideDestination =
          destPath === destRoot || destPath.startsWith(destRoot + sep);
        if (!insideDestination) {
          offset += Math.ceil(size / 512) * 512;
          continue;
        }

        mkdirSync(dirname(destPath), { recursive: true });
        writeFileSync(destPath, tarBuffer.subarray(offset, offset + size));

        if (
          normalizedPath === "SKILL.md" ||
          normalizedPath.endsWith("/SKILL.md")
        ) {
          foundSkillMd = true;
        }
      }
    }

    // Skip to next header (data padded to 512 bytes)
    offset += Math.ceil(size / 512) * 512;
  }
  return foundSkillMd;
}

export async function fetchAndExtractSkill(
  skillId: string,
  destDir: string,
): Promise<void> {
  const url = `${getPlatformUrl()}/v1/skills/${encodeURIComponent(skillId)}/`;
  const response = await fetch(url, {
    headers: buildHeaders(),
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

// ─── SKILLS.md index management ──────────────────────────────────────────────

function atomicWriteFile(filePath: string, content: string): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, `.tmp-${randomUUID()}`);
  writeFileSync(tmpPath, content, "utf-8");
  renameSync(tmpPath, filePath);
}

export function upsertSkillsIndex(id: string): void {
  const indexPath = getSkillsIndexPath();
  let lines: string[] = [];
  if (existsSync(indexPath)) {
    lines = readFileSync(indexPath, "utf-8").split("\n");
  }

  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^[-*]\\s+(?:\`)?${escaped}(?:\`)?\\s*$`);
  if (lines.some((line) => pattern.test(line))) return;

  const nonEmpty = lines.filter((l) => l.trim());
  nonEmpty.push(`- ${id}`);
  const content = nonEmpty.join("\n");
  atomicWriteFile(indexPath, content.endsWith("\n") ? content : content + "\n");
}

export function removeSkillsIndexEntry(id: string): void {
  const indexPath = getSkillsIndexPath();
  if (!existsSync(indexPath)) return;

  const lines = readFileSync(indexPath, "utf-8").split("\n");
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^[-*]\\s+(?:\`)?${escaped}(?:\`)?\\s*$`);
  const filtered = lines.filter((line) => !pattern.test(line));

  // If nothing changed, skip the write
  if (filtered.length === lines.length) return;

  const content = filtered.join("\n");
  atomicWriteFile(indexPath, content.endsWith("\n") ? content : content + "\n");
}

// ─── Install / uninstall ─────────────────────────────────────────────────────

export function uninstallSkillLocally(skillId: string): void {
  const skillDir = join(getWorkspaceSkillsDir(), skillId);

  if (!existsSync(skillDir)) {
    throw new Error(`Skill "${skillId}" is not installed.`);
  }

  rmSync(skillDir, { recursive: true, force: true });
  removeSkillsIndexEntry(skillId);
}

export async function installSkillLocally(
  skillId: string,
  catalogEntry: CatalogSkill,
  overwrite: boolean,
): Promise<void> {
  const skillDir = join(getWorkspaceSkillsDir(), skillId);
  const skillFilePath = join(skillDir, "SKILL.md");

  if (existsSync(skillFilePath) && !overwrite) {
    throw new Error(
      `Skill "${skillId}" is already installed. Use --overwrite to replace it.`,
    );
  }

  mkdirSync(skillDir, { recursive: true });

  // In dev mode, install from the local repo skills directory if available
  const repoSkillsDir = getRepoSkillsDir();
  const repoSkillSource = repoSkillsDir
    ? join(repoSkillsDir, skillId)
    : undefined;

  if (repoSkillSource && existsSync(join(repoSkillSource, "SKILL.md"))) {
    cpSync(repoSkillSource, skillDir, { recursive: true });
  } else {
    await fetchAndExtractSkill(skillId, skillDir);
  }

  // Write version metadata
  if (catalogEntry.version) {
    const meta = {
      version: catalogEntry.version,
      installedAt: new Date().toISOString(),
    };
    atomicWriteFile(
      join(skillDir, "version.json"),
      JSON.stringify(meta, null, 2) + "\n",
    );
  }

  // Install npm dependencies if the skill has a package.json
  if (existsSync(join(skillDir, "package.json"))) {
    const bunPath = `${homedir()}/.bun/bin`;
    execSync("bun install", {
      cwd: skillDir,
      stdio: "inherit",
      env: { ...process.env, PATH: `${bunPath}:${process.env.PATH}` },
    });
  }

  // Register in SKILLS.md only after all steps succeed
  upsertSkillsIndex(skillId);
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
        return local;
      }
      // Skill not found locally — merge with remote so remote-only skills
      // can still be discovered. Local entries take precedence by id.
      try {
        const remote = await fetchCatalog();
        const localIds = new Set(local.map((s) => s.id));
        return [...local, ...remote.filter((s) => !localIds.has(s.id))];
      } catch {
        return local;
      }
    }
  }

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

  await installSkillLocally(skillId, entry, false);
  return true;
}

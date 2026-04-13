/**
 * skillssh-files — SkillFileProvider for skills.sh (GitHub-hosted) skills.
 *
 * Lists files and reads individual file content via the GitHub Contents API
 * and Tree API, without downloading or installing the skill locally.
 *
 * Path resolution (conventional `skills/<slug>/` with tree-search fallback)
 * mirrors the logic in `fetchSkillFromGitHub` from `skillssh-registry.ts`,
 * but only collects metadata (no file content on listing) and fetches
 * content on demand for individual files.
 */

import { basename } from "node:path";

import type { SlimSkillResponse } from "../daemon/message-types/skills.js";
import {
  isTextMimeType as isTextMime,
  MAX_INLINE_TEXT_SIZE,
} from "../runtime/routes/workspace-utils.js";
import { getLogger } from "../util/logger.js";
import type { SkillFileEntry } from "./catalog-files.js";
import {
  hasHiddenOrSkippedSegment,
  sanitizeRelativePath,
  SKIP_DIRS,
} from "./catalog-files.js";
import type { SkillFileProvider } from "./skill-file-provider.js";
import type { GitHubContentsEntry } from "./skillssh-registry.js";
import {
  findSkillDirInTree,
  githubHeaders,
  resolveSkillSource,
} from "./skillssh-registry.js";

const log = getLogger("skillssh-files");

// ─── Path resolution cache ──────────────────────────────────────────────────

interface CacheEntry {
  dirPath: string;
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * In-memory cache for resolved skill directory paths. Keyed by
 * `${owner}/${repo}/${skillSlug}` so repeated requests don't re-probe the
 * GitHub Contents/Tree APIs.
 */
const dirPathCache = new Map<string, CacheEntry>();

function cacheKey(owner: string, repo: string, skillSlug: string): string {
  return `${owner}/${repo}/${skillSlug}`;
}

function getCachedDirPath(
  owner: string,
  repo: string,
  skillSlug: string,
): string | null {
  const key = cacheKey(owner, repo, skillSlug);
  const entry = dirPathCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    dirPathCache.delete(key);
    return null;
  }
  return entry.dirPath;
}

function setCachedDirPath(
  owner: string,
  repo: string,
  skillSlug: string,
  dirPath: string,
): void {
  const key = cacheKey(owner, repo, skillSlug);
  dirPathCache.set(key, { dirPath, expiresAt: Date.now() + CACHE_TTL_MS });
}

// Exported for testing only
export function clearDirPathCache(): void {
  dirPathCache.clear();
}

// ─── Binary classification ──────────────────────────────────────────────────

/**
 * Classify a file as binary from its name alone. Mirrors the
 * `classifyByName` pattern in `catalog-files.ts`.
 */
function classifyByName(name: string): boolean {
  const mime = Bun.file(name).type;
  return !isTextMime(mime, name);
}

// ─── Skill directory resolution ─────────────────────────────────────────────

/**
 * Resolve the directory path for a skill in a GitHub repo. Tries the
 * conventional `skills/<slug>/` path first, falls back to tree search.
 * Returns null if the skill cannot be located.
 */
async function resolveSkillDir(
  owner: string,
  repo: string,
  skillSlug: string,
  ref?: string,
): Promise<string | null> {
  // Check cache first
  const cached = getCachedDirPath(owner, repo, skillSlug);
  if (cached !== null) return cached;

  const headers = githubHeaders();
  const conventionalPath = `skills/${encodeURIComponent(skillSlug)}`;

  const probeUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${conventionalPath}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`;

  const probeResponse = await fetch(probeUrl, {
    headers,
    signal: AbortSignal.timeout(15_000),
  });

  if (probeResponse.ok) {
    setCachedDirPath(owner, repo, skillSlug, conventionalPath);
    return conventionalPath;
  }

  if (probeResponse.status === 404) {
    // Fall back to tree search
    const treeRef = ref ?? "HEAD";
    const foundPath = await findSkillDirInTree(
      owner,
      repo,
      skillSlug,
      treeRef,
      headers,
    );
    if (foundPath) {
      setCachedDirPath(owner, repo, skillSlug, foundPath);
      return foundPath;
    }
    return null;
  }

  // Non-404 error — log and return null
  log.warn(
    { status: probeResponse.status, owner, repo, skillSlug },
    "GitHub Contents API returned non-2xx during skill dir probe",
  );
  return null;
}

// ─── Recursive directory listing ────────────────────────────────────────────

/**
 * Recursively list files in a GitHub directory via the Contents API.
 * Collects `SkillFileEntry` objects with `content: null`. Skips hidden
 * files, `node_modules`, `__pycache__`, `.git` (same filtering as
 * `walkSkillDir` in `catalog-files.ts`).
 */
async function listGitHubDir(
  owner: string,
  repo: string,
  dirPath: string,
  prefix: string,
  ref: string | undefined,
  headers: Record<string, string>,
): Promise<SkillFileEntry[]> {
  let apiUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${dirPath}`;
  if (ref) {
    apiUrl += `?ref=${encodeURIComponent(ref)}`;
  }

  const response = await fetch(apiUrl, {
    headers,
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(
      `GitHub Contents API error: HTTP ${response.status} ${response.statusText}`,
    );
  }

  const entries = (await response.json()) as GitHubContentsEntry[];
  if (!Array.isArray(entries)) return [];

  const result: SkillFileEntry[] = [];

  for (const entry of entries) {
    // Skip hidden files/dirs (same as walkSkillDir)
    if (entry.name.startsWith(".")) continue;

    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.type === "dir") {
      // Skip well-known heavyweight directories
      if (SKIP_DIRS.has(entry.name)) continue;

      const subEntries = await listGitHubDir(
        owner,
        repo,
        `${dirPath}/${entry.name}`,
        relativePath,
        ref,
        headers,
      );
      result.push(...subEntries);
      continue;
    }

    if (entry.type !== "file") continue;

    result.push({
      path: relativePath,
      name: basename(relativePath),
      size: 0, // GitHub Contents API directory listings don't include size
      mimeType: "",
      isBinary: classifyByName(entry.name),
      content: null,
    });
  }

  return result;
}

// ─── Provider implementation ────────────────────────────────────────────────

export function createSkillsShProvider(): SkillFileProvider {
  return {
    canHandle(skillId: string): boolean {
      return skillId.split("/").length >= 3;
    },

    async listFiles(skillId: string): Promise<SkillFileEntry[] | null> {
      let source;
      try {
        source = resolveSkillSource(skillId);
      } catch {
        return null;
      }

      try {
        const dirPath = await resolveSkillDir(
          source.owner,
          source.repo,
          source.skillSlug,
          source.ref,
        );
        if (!dirPath) return null;

        const headers = githubHeaders();
        const entries = await listGitHubDir(
          source.owner,
          source.repo,
          dirPath,
          "",
          source.ref,
          headers,
        );
        entries.sort((a, b) => a.path.localeCompare(b.path));
        return entries;
      } catch (err) {
        log.warn({ err, skillId }, "Failed to list files for skills.sh skill");
        return null;
      }
    },

    async readFileContent(
      skillId: string,
      sanitizedPath: string,
    ): Promise<SkillFileEntry | null> {
      // Re-validate the path even though the caller should have sanitized
      const safe = sanitizeRelativePath(sanitizedPath);
      if (!safe) return null;
      if (hasHiddenOrSkippedSegment(safe)) return null;

      let source;
      try {
        source = resolveSkillSource(skillId);
      } catch {
        return null;
      }

      try {
        const dirPath = await resolveSkillDir(
          source.owner,
          source.repo,
          source.skillSlug,
          source.ref,
        );
        if (!dirPath) return null;

        const headers = githubHeaders();
        const filePath = `${dirPath}/${safe}`;

        // Fetch the file entry via GitHub Contents API
        let apiUrl = `https://api.github.com/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/contents/${filePath}`;
        if (source.ref) {
          apiUrl += `?ref=${encodeURIComponent(source.ref)}`;
        }

        const response = await fetch(apiUrl, {
          headers,
          signal: AbortSignal.timeout(15_000),
        });

        if (!response.ok) return null;

        const entry = (await response.json()) as GitHubContentsEntry & {
          size?: number;
        };

        // Ensure it's a file, not a directory
        if (entry.type !== "file") return null;

        const name = basename(safe);
        const isBinary = classifyByName(name);

        // Return null content for binary files
        if (isBinary) {
          return {
            path: safe,
            name,
            size: entry.size ?? 0,
            mimeType: "",
            isBinary: true,
            content: null,
          };
        }

        // For text files, check size and fetch content
        const size = entry.size ?? 0;
        if (size > MAX_INLINE_TEXT_SIZE) {
          return {
            path: safe,
            name,
            size,
            mimeType: "",
            isBinary: false,
            content: null,
          };
        }

        // Fetch the actual file content via download_url
        if (!entry.download_url) return null;

        const contentResponse = await fetch(entry.download_url, {
          headers,
          signal: AbortSignal.timeout(10_000),
        });

        if (!contentResponse.ok) return null;

        const content = await contentResponse.text();

        return {
          path: safe,
          name,
          size: content.length,
          mimeType: "",
          isBinary: false,
          content,
        };
      } catch (err) {
        log.warn(
          { err, skillId, path: sanitizedPath },
          "Failed to read file content for skills.sh skill",
        );
        return null;
      }
    },

    async toSlimSkill(skillId: string): Promise<SlimSkillResponse | null> {
      try {
        const source = resolveSkillSource(skillId);
        return {
          id: skillId,
          name: source.skillSlug,
          description: "",
          kind: "catalog",
          status: "available",
          origin: "skillssh",
          slug: skillId,
          sourceRepo: `${source.owner}/${source.repo}`,
          installs: 0,
        };
      } catch {
        return null;
      }
    },
  };
}

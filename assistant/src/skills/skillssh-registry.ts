import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

import { getWorkspaceSkillsDir } from "../util/platform.js";
import { upsertSkillsIndex } from "./catalog-install.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SkillsShSearchResult {
  id: string; // e.g. "vercel-labs/agent-skills/vercel-react-best-practices"
  skillId: string; // e.g. "vercel-react-best-practices"
  name: string;
  installs: number;
  source: string; // e.g. "vercel-labs/agent-skills"
}

export type RiskLevel =
  | "safe"
  | "low"
  | "medium"
  | "high"
  | "critical"
  | "unknown";

export interface PartnerAudit {
  risk: RiskLevel;
  alerts?: number;
  score?: number;
  analyzedAt: string;
}

/** Map from audit provider name (e.g. "ath", "socket", "snyk") to audit data */
export type SkillAuditData = Record<string, PartnerAudit>;

/** Map from skill slug to per-provider audit data */
export type AuditResponse = Record<string, SkillAuditData>;

export interface ResolvedSkillSource {
  owner: string;
  repo: string;
  skillSlug: string;
  ref?: string;
}

/** Map of relative file paths to their string contents */
export type SkillFiles = Record<string, string>;

// ─── Display helpers ─────────────────────────────────────────────────────────

const RISK_DISPLAY: Record<RiskLevel, string> = {
  safe: "PASS",
  low: "PASS",
  medium: "WARN",
  high: "FAIL",
  critical: "FAIL",
  unknown: "?",
};

const PROVIDER_DISPLAY: Record<string, string> = {
  ath: "ATH",
  socket: "Socket",
  snyk: "Snyk",
};

export function riskToDisplay(risk: RiskLevel): string {
  return RISK_DISPLAY[risk] ?? "?";
}

export function providerDisplayName(provider: string): string {
  return PROVIDER_DISPLAY[provider] ?? provider;
}

export function formatAuditBadges(auditData: SkillAuditData): string {
  const providers = Object.keys(auditData);
  if (providers.length === 0) return "Security: no audit data";

  const badges = providers.map((provider) => {
    const audit = auditData[provider]!;
    const display = riskToDisplay(audit.risk);
    const name = providerDisplayName(provider);
    return `[${name}:${display}]`;
  });

  return `Security: ${badges.join(" ")}`;
}

// ─── API clients ─────────────────────────────────────────────────────────────

export async function searchSkillsRegistry(
  query: string,
  limit?: number,
): Promise<SkillsShSearchResult[]> {
  const params = new URLSearchParams({ q: query });
  if (limit != null) {
    params.set("limit", String(limit));
  }

  const url = `https://skills.sh/api/search?${params.toString()}`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(
      `skills.sh search failed: HTTP ${response.status} ${response.statusText}`,
    );
  }

  const data = (await response.json()) as { skills: SkillsShSearchResult[] };
  return data.skills ?? [];
}

export async function fetchSkillAudits(
  source: string,
  skillSlugs: string[],
): Promise<AuditResponse> {
  if (skillSlugs.length === 0) return {};

  const params = new URLSearchParams({
    source,
    skills: skillSlugs.join(","),
  });

  const url = `https://add-skill.vercel.sh/audit?${params.toString()}`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(
      `Audit fetch failed: HTTP ${response.status} ${response.statusText}`,
    );
  }

  return (await response.json()) as AuditResponse;
}

// ─── Source resolution ──────────────────────────────────────────────────────

/**
 * Parse a skill source string into owner, repo, and skill slug.
 *
 * Supported formats:
 *   - `owner/repo@skill-name`
 *   - `owner/repo/skill-name`
 *   - `https://github.com/owner/repo/tree/<branch>/skills/skill-name`
 */
export function resolveSkillSource(source: string): ResolvedSkillSource {
  // Full GitHub URL — capture the branch for ref passthrough
  // Branch capture uses non-greedy `.+?` to handle branch names with slashes (e.g. feature/new-flow)
  const urlMatch = source.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/(.+?)\/skills\/([a-z0-9][a-z0-9._-]*)\/?$/,
  );
  if (urlMatch) {
    return {
      owner: urlMatch[1]!,
      repo: urlMatch[2]!,
      skillSlug: urlMatch[4]!,
      ref: urlMatch[3]!,
    };
  }

  // owner/repo@skill-name — restrict slug to safe characters
  const atMatch = source.match(/^([^/]+)\/([^/@]+)@([a-z0-9][a-z0-9._-]*)$/);
  if (atMatch) {
    return { owner: atMatch[1]!, repo: atMatch[2]!, skillSlug: atMatch[3]! };
  }

  // owner/repo/skill-name (exactly 3 segments) — restrict slug to safe characters
  const slashMatch = source.match(/^([^/]+)\/([^/]+)\/([a-z0-9][a-z0-9._-]*)$/);
  if (slashMatch) {
    return {
      owner: slashMatch[1]!,
      repo: slashMatch[2]!,
      skillSlug: slashMatch[3]!,
    };
  }

  throw new Error(
    `Invalid skill source "${source}". Expected one of:\n` +
      `  owner/repo@skill-name\n` +
      `  owner/repo/skill-name\n` +
      `  https://github.com/owner/repo/tree/<branch>/skills/skill-name`,
  );
}

// ─── GitHub fetch ───────────────────────────────────────────────────────────

interface GitHubContentsEntry {
  name: string;
  type: "file" | "dir";
  download_url: string | null;
}

/** Build common headers for GitHub API requests (User-Agent + optional auth). */
function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "vellum-assistant",
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    headers["Authorization"] = `token ${token}`;
  }
  return headers;
}

interface GitHubTreeEntry {
  path: string;
  type: "blob" | "tree";
}

/**
 * Search the repo tree for a directory containing `<slug>/SKILL.md`.
 * Returns the directory path (e.g. "examples/skills-tool/skills/csv") or null.
 */
async function findSkillDirInTree(
  owner: string,
  repo: string,
  skillSlug: string,
  ref: string,
  headers: Record<string, string>,
): Promise<string | null> {
  const treeUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
  const response = await fetch(treeUrl, {
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) return null;

  const data = (await response.json()) as { tree: GitHubTreeEntry[] };
  const suffix = `${skillSlug}/SKILL.md`;
  const match = data.tree.find(
    (entry) =>
      entry.type === "blob" &&
      (entry.path === suffix || entry.path.endsWith(`/${suffix}`)),
  );
  if (!match) return null;

  // Return the directory containing SKILL.md (strip the trailing /SKILL.md)
  return match.path.slice(0, -"/SKILL.md".length);
}

/**
 * Fetch SKILL.md and supporting files from a GitHub-hosted skills directory.
 *
 * First tries the conventional `skills/<slug>/` path. If that returns a 404,
 * falls back to searching the full repo tree for `<slug>/SKILL.md` at any
 * depth (handles repos like `vercel-labs/bash-tool` where skills live at
 * non-standard paths like `examples/skills-tool/skills/csv/`).
 *
 * Uses the GitHub Contents API for directory listing and file downloads.
 * Recursively fetches subdirectories (e.g. scripts/, references/).
 */
export async function fetchSkillFromGitHub(
  owner: string,
  repo: string,
  skillSlug: string,
  ref?: string,
): Promise<SkillFiles> {
  const headers = githubHeaders();

  async function fetchDir(
    subpath: string,
    prefix: string,
  ): Promise<SkillFiles> {
    let apiUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${subpath}`;
    if (ref) {
      apiUrl += `?ref=${encodeURIComponent(ref)}`;
    }

    const response = await fetch(apiUrl, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      throw new Error(
        `GitHub API error: HTTP ${response.status} ${response.statusText}`,
      );
    }

    const entries = (await response.json()) as GitHubContentsEntry[];
    if (!Array.isArray(entries)) {
      throw new Error(
        `Expected a directory listing for ${subpath}/ but got a single file`,
      );
    }

    const files: SkillFiles = {};
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.type === "dir") {
        // Recursively fetch subdirectory contents
        const subFiles = await fetchDir(
          `${subpath}/${entry.name}`,
          relativePath,
        );
        Object.assign(files, subFiles);
        continue;
      }

      if (entry.type !== "file" || !entry.download_url) continue;
      const fileResponse = await fetch(entry.download_url, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      if (!fileResponse.ok) {
        throw new Error(
          `Failed to download ${relativePath}: HTTP ${fileResponse.status}`,
        );
      }
      files[relativePath] = await fileResponse.text();
    }

    return files;
  }

  // Try the conventional skills/<slug>/ path first
  const conventionalPath = `skills/${encodeURIComponent(skillSlug)}`;
  let skillDirPath = conventionalPath;

  const probeUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${conventionalPath}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`;
  const probeResponse = await fetch(probeUrl, {
    headers,
    signal: AbortSignal.timeout(15_000),
  });

  if (probeResponse.status === 404) {
    // Fall back to searching the repo tree for <slug>/SKILL.md at any path
    const treeRef = ref ?? "HEAD";
    const foundPath = await findSkillDirInTree(
      owner,
      repo,
      skillSlug,
      treeRef,
      headers,
    );
    if (!foundPath) {
      throw new Error(
        `Skill "${skillSlug}" not found in ${owner}/${repo}. ` +
          `Searched skills/${skillSlug}/ and the full repo tree.`,
      );
    }
    skillDirPath = foundPath;
  } else if (!probeResponse.ok) {
    throw new Error(
      `GitHub API error: HTTP ${probeResponse.status} ${probeResponse.statusText}`,
    );
  }

  // If we already have the probe response for the conventional path and it was
  // successful, we can use it directly instead of re-fetching.
  let files: SkillFiles;
  if (skillDirPath === conventionalPath && probeResponse.ok) {
    const entries = (await probeResponse.json()) as GitHubContentsEntry[];
    if (!Array.isArray(entries)) {
      throw new Error(
        `Expected a directory listing for ${conventionalPath}/ but got a single file`,
      );
    }
    // Fetch the directory contents from the already-parsed probe response
    const result: SkillFiles = {};
    for (const entry of entries) {
      if (entry.type === "dir") {
        const subFiles = await fetchDir(
          `${conventionalPath}/${entry.name}`,
          entry.name,
        );
        Object.assign(result, subFiles);
        continue;
      }
      if (entry.type !== "file" || !entry.download_url) continue;
      const fileResponse = await fetch(entry.download_url, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      if (!fileResponse.ok) {
        throw new Error(
          `Failed to download ${entry.name}: HTTP ${fileResponse.status}`,
        );
      }
      result[entry.name] = await fileResponse.text();
    }
    files = result;
  } else {
    files = await fetchDir(skillDirPath, "");
  }

  if (!files["SKILL.md"]) {
    throw new Error(`SKILL.md not found in ${owner}/${repo}/${skillDirPath}/`);
  }

  return files;
}

// ─── External skill installation ────────────────────────────────────────────

// ─── Slug validation ────────────────────────────────────────────────────────

const VALID_SKILL_SLUG = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Validate that a skill slug is safe for use in filesystem paths.
 * Follows the same pattern as `validateManagedSkillId` in managed-store.ts.
 */
export function validateSkillSlug(slug: string): void {
  if (!slug || typeof slug !== "string") {
    throw new Error("Skill slug is required");
  }
  if (slug.includes("..") || slug.includes("/") || slug.includes("\\")) {
    throw new Error(
      `Invalid skill slug "${slug}": must not contain path traversal characters`,
    );
  }
  if (!VALID_SKILL_SLUG.test(slug)) {
    throw new Error(
      `Invalid skill slug "${slug}": must start with a lowercase letter or digit and contain only lowercase letters, digits, dots, hyphens, and underscores`,
    );
  }
}

/**
 * Install a community skill from a GitHub-hosted skills.sh registry repo.
 *
 * 1. Validates the skill slug for path safety
 * 2. Fetches all files from `skills/<skillSlug>/` in the source repo
 * 3. Writes them to `<workspace>/skills/<skillSlug>/` with path traversal protection
 * 4. Writes `version.json` with origin metadata
 * 5. Runs `bun install` if a `package.json` is present
 * 6. Registers the skill in SKILLS.md only after all steps succeed
 */
export async function installExternalSkill(
  owner: string,
  repo: string,
  skillSlug: string,
  overwrite: boolean,
  ref?: string,
): Promise<void> {
  // Validate slug before using in filesystem paths
  validateSkillSlug(skillSlug);

  const skillDir = join(getWorkspaceSkillsDir(), skillSlug);
  const skillFilePath = join(skillDir, "SKILL.md");

  if (existsSync(skillFilePath) && !overwrite) {
    throw new Error(
      `Skill "${skillSlug}" is already installed. Use --overwrite to replace it.`,
    );
  }

  const files = await fetchSkillFromGitHub(owner, repo, skillSlug, ref);

  // Clear existing directory on overwrite to remove stale files
  if (overwrite && existsSync(skillDir)) {
    rmSync(skillDir, { recursive: true, force: true });
  }
  mkdirSync(skillDir, { recursive: true });

  // Write files with path traversal protection (follows extractTarToDir pattern)
  for (const [filename, content] of Object.entries(files)) {
    const normalized = filename.replace(/\\/g, "/").replace(/^\.\/+/g, "");
    if (!normalized || normalized.includes("..") || normalized.startsWith("/"))
      continue;
    const destPath = resolve(skillDir, normalized);
    if (
      !destPath.startsWith(resolve(skillDir) + sep) &&
      destPath !== resolve(skillDir)
    )
      continue;
    mkdirSync(dirname(destPath), { recursive: true });
    writeFileSync(destPath, content, "utf-8");
  }

  // Write origin metadata
  const meta = {
    origin: "skills.sh",
    source: `${owner}/${repo}`,
    skillSlug,
    installedAt: new Date().toISOString(),
  };
  writeFileSync(
    join(skillDir, "version.json"),
    JSON.stringify(meta, null, 2) + "\n",
    "utf-8",
  );

  // Install npm dependencies if the skill ships a package.json
  if (existsSync(join(skillDir, "package.json"))) {
    const bunPath = `${homedir()}/.bun/bin`;
    execSync("bun install", {
      cwd: skillDir,
      stdio: "inherit",
      env: { ...process.env, PATH: `${bunPath}:${process.env.PATH}` },
    });
  }

  // Register in SKILLS.md only after files are written and deps installed
  upsertSkillsIndex(skillSlug);
}

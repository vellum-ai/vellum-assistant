import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import { getWorkspaceSkillsDir } from "../util/platform.js";
import {
  commitStagedSkillInstall,
  createSkillInstallStagingDir,
  installSkillDependenciesIfPresent,
  writeSkillFilesToDir,
} from "./catalog-install.js";
import { computeSkillHash, writeInstallMeta } from "./install-meta.js";
import type {
  AuditResponse,
  PartnerAudit,
  RiskLevel,
  SkillAuditData,
} from "./skillssh-audit-types.js";

export type { AuditResponse, PartnerAudit, RiskLevel, SkillAuditData };

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SkillsShSearchResult {
  id: string; // e.g. "vercel-labs/agent-skills/vercel-react-best-practices"
  skillId: string; // e.g. "vercel-react-best-practices"
  name: string;
  installs: number;
  source: string; // e.g. "vercel-labs/agent-skills"
}

export interface ResolvedSkillSource {
  owner: string;
  repo: string;
  skillSlug?: string; // undefined when isPackageInstall is true
  ref?: string;
  isPackageInstall?: boolean; // true for 2-segment format (owner/repo); false or undefined for single-skill installs
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
 * Parse a skill source string into owner, repo, and optionally skill slug.
 *
 * Supported formats:
 *   - `owner/repo` — package install (installs all skills in the package)
 *   - `owner/repo@skill-name` — single skill from a package
 *   - `owner/repo/skill-name` — single skill (namespaced form)
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
      isPackageInstall: false,
    };
  }

  // owner/repo@skill-name — restrict slug to safe characters
  const atMatch = source.match(/^([^/]+)\/([^/@]+)@([a-z0-9][a-z0-9._-]*)$/);
  if (atMatch) {
    return {
      owner: atMatch[1]!,
      repo: atMatch[2]!,
      skillSlug: atMatch[3]!,
      isPackageInstall: false,
    };
  }

  // owner/repo/skill-name (exactly 3 segments) — restrict slug to safe characters
  const slashMatch = source.match(/^([^/]+)\/([^/]+)\/([a-z0-9][a-z0-9._-]*)$/);
  if (slashMatch) {
    return {
      owner: slashMatch[1]!,
      repo: slashMatch[2]!,
      skillSlug: slashMatch[3]!,
      isPackageInstall: false,
    };
  }

  // owner/repo (exactly 2 segments) — package install format. repo must be safe (no @, etc.)
  const pkgMatch = source.match(/^([^/@]+)\/([^/@]+)$/);
  if (pkgMatch) {
    return {
      owner: pkgMatch[1]!,
      repo: pkgMatch[2]!,
      isPackageInstall: true,
    };
  }

  throw new Error(
    `Invalid skill source "${source}". Expected one of:\n` +
      `  owner/repo (package install — installs all skills)\n` +
      `  owner/repo@skill-name\n` +
      `  owner/repo/skill-name\n` +
      `  https://github.com/owner/repo/tree/<branch>/skills/skill-name`,
  );
}

// ─── GitHub fetch ───────────────────────────────────────────────────────────

export interface GitHubContentsEntry {
  name: string;
  type: "file" | "dir";
  download_url: string | null;
}

/** Build common headers for GitHub API requests (User-Agent + optional auth). */
export function githubHeaders(): Record<string, string> {
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

export interface GitHubTreeEntry {
  path: string;
  type: "blob" | "tree";
}

/**
 * Search the repo tree for a directory containing `<slug>/SKILL.md`.
 * Returns the directory path (e.g. "examples/skills-tool/skills/csv") or null.
 */
export async function findSkillDirInTree(
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
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(
      `GitHub API error while searching repo tree: HTTP ${response.status} ${response.statusText}`,
    );
  }

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

/**
 * Per-segment regex. A valid skill slug is either:
 *   - One segment: `<name>` (legacy + vellum + bundled skills)
 *   - Three segments: `<owner>/<repo>/<name>` (third-party package-namespaced)
 *
 * Two-segment slugs are reserved for the package-install argument
 * (`assistant skills add owner/repo`) and are rejected as stored slugs.
 */
const VALID_SKILL_SLUG_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Validate that a skill slug is safe for use in filesystem paths.
 * Follows the same pattern as `validateManagedSkillId` in managed-store.ts.
 *
 * Accepts either single-segment (`my-skill`) or three-segment namespaced
 * (`owner/repo/skill-name`) slugs. The latter is used for third-party
 * package installs so multiple skills from the same package can coexist
 * without collision.
 */
export function validateSkillSlug(slug: string): void {
  if (!slug || typeof slug !== "string") {
    throw new Error("Skill slug is required");
  }
  if (slug.includes("..") || slug.includes("\\")) {
    throw new Error(
      `Invalid skill slug "${slug}": must not contain path traversal characters`,
    );
  }
  const segments = slug.split("/");
  if (segments.length !== 1 && segments.length !== 3) {
    throw new Error(
      `Invalid skill slug "${slug}": must be a single name or three-segment namespaced form "owner/repo/skill"`,
    );
  }
  for (const segment of segments) {
    if (!VALID_SKILL_SLUG_SEGMENT.test(segment)) {
      throw new Error(
        `Invalid skill slug "${slug}": each segment must start with a lowercase letter or digit and contain only lowercase letters, digits, dots, hyphens, and underscores`,
      );
    }
  }
}

/**
 * Install a community skill from a GitHub-hosted skills.sh registry repo.
 *
 * 1. Validates the skill slug for path safety
 * 2. Fetches all files from `skills/<skillSlug>/` in the source repo
 * 3. Writes them to a non-discovered staging dir with path traversal protection
 * 4. Writes `install-meta.json` with origin metadata
 * 5. Installs npm dependencies (if package.json exists)
 * 6. Atomically swaps the staged skill into `<workspace>/skills/<skillSlug>/`
 *
 * Auto-enable and memory seeding are handled by the caller (e.g.
 * `postInstallSkill()` in the daemon, or left to the user for CLI installs).
 */
export async function installExternalSkill(
  owner: string,
  repo: string,
  skillSlug: string,
  overwrite: boolean,
  ref?: string,
  contactId?: string,
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

  const stagedDir = createSkillInstallStagingDir();
  try {
    writeSkillFilesToDir(files, stagedDir);

    writeInstallMeta(stagedDir, {
      origin: "skillssh",
      slug: skillSlug,
      sourceRepo: `${owner}/${repo}`,
      installedAt: new Date().toISOString(),
      ...(contactId ? { installedBy: contactId } : {}),
      contentHash: computeSkillHash(stagedDir) ?? undefined,
    });

    installSkillDependenciesIfPresent(stagedDir);
    commitStagedSkillInstall(skillSlug, stagedDir);
  } catch (err) {
    rmSync(stagedDir, { recursive: true, force: true });
    throw err;
  }
}

// ─── Package install (multi-skill repos) ─────────────────────────────────────

/**
 * Install all skills from a GitHub-hosted package repository.
 *
 * Discovers all skills in the repo, then installs each one with atomic
 * rollback on failure (all-or-nothing semantics).
 *
 * Returns an object describing which skills were installed, skipped, and failed.
 */
export interface PackageInstallResult {
  installed: Array<{ slug: string; skillId: string }>;
  skipped: Array<{ slug: string; reason: string }>;
  failed: Array<{ slug: string; error: string }>;
}

export async function installPackage(
  owner: string,
  repo: string,
  overwrite: boolean,
  ref?: string,
  contactId?: string,
): Promise<PackageInstallResult> {
  const { listPackageSkills } = await import(
    "./skillssh-package-discovery.js"
  );

  const packageKey = `${owner}/${repo}`;
  const packageContentHash = "v2:placeholder"; // TODO: compute actual hash after discovery

  // Discover all skills in the package
  const discovered = await listPackageSkills(owner, repo, ref);
  if (discovered.length === 0) {
    throw new Error(
      `No skills found in package "${packageKey}". Expected skills in a "skills/" directory.`,
    );
  }

  const result: PackageInstallResult = {
    installed: [],
    skipped: [],
    failed: [],
  };

  // Install each skill with namespaced path: owner/repo/skill-name
  for (const { slug } of discovered) {
    const skillId = `${packageKey}/${slug}`;

    try {
      // Validate the namespaced skill id
      validateSkillSlug(skillId);

      const skillDir = join(getWorkspaceSkillsDir(), skillId);
      const skillFilePath = join(skillDir, "SKILL.md");

      // Check if already installed
      if (existsSync(skillFilePath) && !overwrite) {
        result.skipped.push({
          slug,
          reason: "already installed (use --overwrite to replace)",
        });
        continue;
      }

      // Fetch this specific skill from the repo
      const files = await fetchSkillFromGitHub(owner, repo, slug, ref);

      const stagedDir = createSkillInstallStagingDir();
      try {
        writeSkillFilesToDir(files, stagedDir);

        writeInstallMeta(stagedDir, {
          origin: "skillssh",
          slug: skillId,
          sourceRepo: `${owner}/${repo}`,
          installedAt: new Date().toISOString(),
          ...(contactId ? { installedBy: contactId } : {}),
          package: packageKey,
          packageContentHash: packageContentHash,
          contentHash: computeSkillHash(stagedDir) ?? undefined,
        });

        installSkillDependenciesIfPresent(stagedDir);
        commitStagedSkillInstall(skillId, stagedDir);

        result.installed.push({ slug, skillId });
      } catch (err) {
        rmSync(stagedDir, { recursive: true, force: true });
        throw err;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.failed.push({ slug, error: message });
    }
  }

  return result;
}

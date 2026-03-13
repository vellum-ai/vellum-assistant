import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { upsertSkillsIndex } from "./catalog-install.js";
import { getWorkspaceSkillsDir } from "../util/platform.js";

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

  return (await response.json()) as SkillsShSearchResult[];
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
  // Full GitHub URL
  const urlMatch = source.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/[^/]+\/skills\/([^/]+)\/?$/,
  );
  if (urlMatch) {
    return { owner: urlMatch[1]!, repo: urlMatch[2]!, skillSlug: urlMatch[3]! };
  }

  // owner/repo@skill-name
  const atMatch = source.match(/^([^/]+)\/([^/@]+)@(.+)$/);
  if (atMatch) {
    return { owner: atMatch[1]!, repo: atMatch[2]!, skillSlug: atMatch[3]! };
  }

  // owner/repo/skill-name (exactly 3 segments)
  const slashMatch = source.match(/^([^/]+)\/([^/]+)\/([^/]+)$/);
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

/**
 * Fetch SKILL.md and supporting files from a GitHub-hosted skills directory.
 *
 * Uses the GitHub Contents API: `GET /repos/:owner/:repo/contents/skills/:slug`
 * and follows each file's `download_url` to retrieve content.
 */
export async function fetchSkillFromGitHub(
  owner: string,
  repo: string,
  skillSlug: string,
): Promise<SkillFiles> {
  const apiUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/skills/${encodeURIComponent(skillSlug)}`;
  const response = await fetch(apiUrl, {
    headers: { Accept: "application/vnd.github.v3+json" },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(
        `Skill "${skillSlug}" not found in ${owner}/${repo}. ` +
          `Looked in skills/${skillSlug}/`,
      );
    }
    throw new Error(
      `GitHub API error: HTTP ${response.status} ${response.statusText}`,
    );
  }

  const entries = (await response.json()) as GitHubContentsEntry[];
  if (!Array.isArray(entries)) {
    throw new Error(
      `Expected a directory listing for skills/${skillSlug}/ but got a single file`,
    );
  }

  const files: SkillFiles = {};
  for (const entry of entries) {
    if (entry.type !== "file" || !entry.download_url) continue;
    const fileResponse = await fetch(entry.download_url, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!fileResponse.ok) {
      throw new Error(
        `Failed to download ${entry.name}: HTTP ${fileResponse.status}`,
      );
    }
    files[entry.name] = await fileResponse.text();
  }

  if (!files["SKILL.md"]) {
    throw new Error(
      `SKILL.md not found in ${owner}/${repo}/skills/${skillSlug}/`,
    );
  }

  return files;
}

// ─── External skill installation ────────────────────────────────────────────

/**
 * Install a community skill from a GitHub-hosted skills.sh registry repo.
 *
 * 1. Fetches all files from `skills/<skillSlug>/` in the source repo
 * 2. Writes them to `<workspace>/skills/<skillSlug>/`
 * 3. Writes `version.json` with origin metadata
 * 4. Registers the skill in SKILLS.md
 * 5. Runs `bun install` if a `package.json` is present
 */
export async function installExternalSkill(
  owner: string,
  repo: string,
  skillSlug: string,
  overwrite: boolean,
): Promise<void> {
  const skillDir = join(getWorkspaceSkillsDir(), skillSlug);
  const skillFilePath = join(skillDir, "SKILL.md");

  if (existsSync(skillFilePath) && !overwrite) {
    throw new Error(
      `Skill "${skillSlug}" is already installed. Use --overwrite to replace it.`,
    );
  }

  const files = await fetchSkillFromGitHub(owner, repo, skillSlug);

  mkdirSync(skillDir, { recursive: true });

  for (const [filename, content] of Object.entries(files)) {
    writeFileSync(join(skillDir, filename), content, "utf-8");
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

  // Register in SKILLS.md only after files are written
  upsertSkillsIndex(skillSlug);

  // Install npm dependencies if the skill ships a package.json
  if (existsSync(join(skillDir, "package.json"))) {
    const bunPath = `${homedir()}/.bun/bin`;
    execSync("bun install", {
      cwd: skillDir,
      stdio: "inherit",
      env: { ...process.env, PATH: `${bunPath}:${process.env.PATH}` },
    });
  }
}

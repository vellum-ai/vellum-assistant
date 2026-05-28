import { githubHeaders,type GitHubTreeEntry } from "./skillssh-registry.js";

export interface DiscoveredSkill {
  slug: string; // e.g. "brainstorming"
  dirPath: string; // e.g. "skills/brainstorming"
}

/**
 * Discover all skills in a GitHub-hosted package repository.
 *
 * Tries the conventional `skills/` layout first:
 *   - Queries GitHub Contents API for `skills/` directory
 *   - Lists subdirectories that contain a `SKILL.md` file
 *   - Returns the discovered skills
 *
 * Falls back to a shallow tree walk (depth ≤ 4) if:
 *   - The `skills/` directory doesn't exist
 *   - Or any non-conventional layout is detected
 *
 * Returns an array of discovered skills with their slug and directory path.
 * Throws if the repo cannot be accessed or the tree is malformed.
 */
export async function listPackageSkills(
  owner: string,
  repo: string,
  ref?: string,
): Promise<DiscoveredSkill[]> {
  const headers = githubHeaders();

  // First, try to fetch the conventional `skills/` directory
  const discovered = await tryConventionalLayout(
    owner,
    repo,
    ref,
    headers,
  );

  if (discovered.length > 0) {
    return discovered;
  }

  // Fall back to tree walk if no conventional layout found
  return await discoverViaTreeWalk(owner, repo, ref, headers);
}

/**
 * Try the conventional `skills/<name>/` layout.
 *
 * Probes the GitHub Contents API for the `skills/` directory,
 * then checks each subdirectory for the presence of `SKILL.md`.
 * Returns the discovered skills, or an empty array if the directory doesn't exist.
 */
async function tryConventionalLayout(
  owner: string,
  repo: string,
  ref: string | undefined,
  headers: Record<string, string>,
): Promise<DiscoveredSkill[]> {
  const conventionalPath = "skills";
  let apiUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${conventionalPath}`;
  if (ref) {
    apiUrl += `?ref=${encodeURIComponent(ref)}`;
  }

  const response = await fetch(apiUrl, {
    headers,
    signal: AbortSignal.timeout(15_000),
  });

  if (response.status === 404) {
    // No conventional layout; fall back to tree walk
    return [];
  }

  if (!response.ok) {
    throw new Error(
      `GitHub API error fetching ${conventionalPath}/: HTTP ${response.status} ${response.statusText}`,
    );
  }

  const entries = (await response.json()) as GitHubContentsEntry[];
  if (!Array.isArray(entries)) {
    // Not a directory; treat as empty
    return [];
  }

  const discovered: DiscoveredSkill[] = [];

  for (const entry of entries) {
    if (entry.type !== "dir") continue;

    // Check if this subdirectory has a SKILL.md
    const skillMdUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${conventionalPath}/${entry.name}/SKILL.md${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`;

    const skillMdResponse = await fetch(skillMdUrl, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });

    // If SKILL.md exists, this is a valid skill
    if (skillMdResponse.ok) {
      discovered.push({
        slug: entry.name,
        dirPath: `${conventionalPath}/${entry.name}`,
      });
    }
  }

  return discovered;
}

/**
 * Discover skills via a tree walk.
 *
 * Fetches the repo tree recursively (depth ≤ 4) and searches for any
 * directory containing `SKILL.md`. Returns an array of discovered skills.
 * Empty array if the repo is empty or has no skills.
 */
async function discoverViaTreeWalk(
  owner: string,
  repo: string,
  ref: string | undefined,
  headers: Record<string, string>,
): Promise<DiscoveredSkill[]> {
  const treeRef = ref ?? "HEAD";
  const treeUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(treeRef)}?recursive=1`;

  const response = await fetch(treeUrl, {
    headers,
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    throw new Error(
      `GitHub tree API error: HTTP ${response.status} ${response.statusText}`,
    );
  }

  const data = (await response.json()) as { tree: GitHubTreeEntry[] };
  const tree = data.tree ?? [];

  // Find all SKILL.md files
  const skillMdPaths = tree
    .filter((entry) => entry.type === "blob" && entry.path.endsWith("/SKILL.md"))
    .map((entry) => entry.path);

  // For each SKILL.md, extract the skill slug and parent directory path
  const discovered: DiscoveredSkill[] = [];
  const seenSlugs = new Set<string>();

  for (const path of skillMdPaths) {
    // path is like "examples/skills/foo/SKILL.md"
    const parentDir = path.substring(0, path.length - "/SKILL.md".length);
    const slug = parentDir.split("/").pop();

    if (!slug || seenSlugs.has(slug)) {
      // Skip empty slugs and duplicates (keep the first occurrence)
      continue;
    }

    // Reject nested skills (e.g. "skills/foo/skills/bar/SKILL.md" is too deep)
    const depth = parentDir.split("/").length;
    if (depth > 4) {
      continue;
    }

    seenSlugs.add(slug);
    discovered.push({
      slug,
      dirPath: parentDir,
    });
  }

  return discovered;
}

/**
 * GitHub Contents API response entry (simplified).
 */
interface GitHubContentsEntry {
  name: string;
  path: string;
  type: "file" | "dir";
  download_url?: string;
}

import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { getLogger } from "../util/logger.js";
import { getWorkspaceSkillsDir } from "../util/platform.js";

const log = getLogger("skillssh");

// Managed skills directory — where installed skill folders live
function getManagedSkillsDir(): string {
  return getWorkspaceSkillsDir();
}

// Skills.sh project root — skillssh creates a `skills/` subdir inside its cwd,
// so we use the parent of the managed skills dir as the project root.
function getSkillsshProjectRoot(): string {
  return dirname(getWorkspaceSkillsDir());
}

// Validate slug format (alphanumeric, hyphens, dots, underscores; optional namespace with single slash)
function validateSlug(slug: string): boolean {
  return /^[a-zA-Z0-9]([a-zA-Z0-9._-]*(\/[a-zA-Z0-9][a-zA-Z0-9._-]*)?)?$/.test(
    slug,
  );
}

// ─── Content hash verification (trust-on-first-use) ──────────────────────────

interface IntegrityRecord {
  sha256: string;
  installedAt: string;
}

type IntegrityManifest = Record<string, IntegrityRecord>;

function getIntegrityPath(): string {
  return join(getManagedSkillsDir(), ".integrity.json");
}

export function loadIntegrityManifest(): IntegrityManifest {
  const path = getIntegrityPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as IntegrityManifest;
  } catch {
    log.warn("Failed to parse integrity manifest, starting fresh");
    return {};
  }
}

function saveIntegrityManifest(manifest: IntegrityManifest): void {
  writeFileSync(
    getIntegrityPath(),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf-8",
  );
}

/** Collect all file contents in a directory tree, sorted by relative path for determinism. */
function collectFileContents(
  dir: string,
  prefix = "",
): Array<{ relPath: string; content: Buffer }> {
  const results: Array<{ relPath: string; content: Buffer }> = [];
  if (!existsSync(dir)) return results;

  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFileContents(fullPath, relPath));
    } else if (entry.isFile()) {
      results.push({ relPath, content: readFileSync(fullPath) });
    }
  }
  return results.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

/**
 * Compute a SHA-256 hash over all files in a skill directory.
 * Returns format: "v2:sha256hex" (version prefix added to support hash format evolution).
 */
function computeSkillHash(skillDir: string): string | null {
  if (!existsSync(skillDir) || !statSync(skillDir).isDirectory()) return null;

  const files = collectFileContents(skillDir);
  if (files.length === 0) return null;

  const hasher = new Bun.CryptoHasher("sha256");
  for (const file of files) {
    // Length-prefix each segment to prevent boundary ambiguity collisions
    const pathBuf = Buffer.from(file.relPath, "utf-8");
    hasher.update(`${pathBuf.length}:`);
    hasher.update(pathBuf);
    hasher.update(`${file.content.length}:`);
    hasher.update(file.content);
  }
  return `v2:${hasher.digest("hex")}`;
}

/**
 * Record or verify the content hash of an installed skill.
 * On first install: stores the hash (trust-on-first-use).
 * On subsequent installs: compares with stored hash and warns on mismatch.
 */
export function verifyAndRecordSkillHash(slug: string): void {
  const skillDir = join(getManagedSkillsDir(), slug);
  const hash = computeSkillHash(skillDir);
  if (!hash) {
    log.warn({ slug }, "Could not compute content hash for installed skill");
    return;
  }

  const manifest = loadIntegrityManifest();
  const existing = manifest[slug];

  if (existing) {
    const storedHash = existing.sha256;

    // Guard against corrupted manifest entries where sha256 is not a string
    if (typeof storedHash !== "string") {
      log.warn(
        { slug },
        "Integrity manifest entry has non-string sha256 — re-recording hash",
      );
    } else if (!storedHash.startsWith("v2:")) {
      // Unknown format (not v2: prefix) — warn about integrity mismatch
      log.warn(
        { slug, stored: storedHash, actual: hash },
        "Stored hash has unrecognized format — possible integrity mismatch. Re-recording.",
      );
    } else if (storedHash !== hash) {
      log.warn(
        { slug, expected: storedHash, actual: hash },
        "Skill content hash changed — content differs from previous install. " +
          "This is expected for updates but could indicate CDN tampering.",
      );
    } else {
      log.info(
        { slug },
        "Skill content hash verified — matches previous install",
      );
    }
  } else {
    log.info(
      { slug, sha256: hash },
      "Recorded initial content hash for skill (trust-on-first-use)",
    );
  }

  // Always store the latest hash
  manifest[slug] = { sha256: hash, installedAt: new Date().toISOString() };
  saveIntegrityManifest(manifest);
}

interface SkillsshInstallResult {
  success: boolean;
  skillName?: string;
  version?: string;
  error?: string;
}

interface SkillsshSearchResultItem {
  name: string;
  slug: string;
  description: string;
  author: string;
  stars: number;
  installs: number;
  version: string;
  createdAt: number;
  /** Where this skill comes from: "vellum" (first-party) or "skillssh" (community). */
  source: "vellum" | "skillssh";
}

interface SkillsshSearchResult {
  skills: SkillsshSearchResultItem[];
}

interface SkillsshUpdateResult {
  success: boolean;
  updatedVersion?: string;
  error?: string;
}

interface SkillsshUpdateCheckItem {
  name: string;
  installedVersion: string;
  latestVersion: string;
}

// Helper to run skillssh commands
async function runSkillssh(
  args: string[],
  opts?: { cwd?: string; timeout?: number },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const cwd = opts?.cwd ?? getSkillsshProjectRoot();
  const timeout = opts?.timeout ?? 60000;

  // Ensure managed skills dir exists
  const { mkdirSync } = await import("node:fs");
  mkdirSync(cwd, { recursive: true });

  log.info({ args, cwd }, "Running skillssh command");

  const proc = Bun.spawn(["npx", "skillssh", ...args], {
    cwd,
    env: { ...process.env, SKILLSSH_DISABLE_TELEMETRY: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });

  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<[string, string]>((_, reject) => {
    timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`skillssh command timed out after ${timeout}ms`));
    }, timeout);
  });

  const [stdout, stderr] = await Promise.race([
    Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]),
    timeoutPromise,
  ]).finally(() => clearTimeout(timer!));

  // Suppress unhandled rejection from the losing timeout promise
  timeoutPromise.catch(() => {});

  const exitCode = await proc.exited;

  log.info(
    { exitCode, stdoutLen: stdout.length, stderrLen: stderr.length },
    "skillssh command completed",
  );

  return { stdout, stderr, exitCode };
}

export async function skillsshInstall(
  slug: string,
  opts?: { version?: string },
): Promise<SkillsshInstallResult> {
  if (!validateSlug(slug)) {
    return { success: false, error: `Invalid skill slug: ${slug}` };
  }

  const installSlug = opts?.version ? `${slug}@${opts.version}` : slug;
  const args = ["install", installSlug, "--force"]; // non-interactive

  try {
    const result = await runSkillssh(args);
    if (result.exitCode !== 0) {
      const error =
        result.stderr.trim() || result.stdout.trim() || "Unknown error";
      return { success: false, error };
    }
    verifyAndRecordSkillHash(slug);
    return { success: true, skillName: slug };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

export async function skillsshUpdate(
  name: string,
): Promise<SkillsshUpdateResult> {
  try {
    const result = await runSkillssh(["update", name, "--force"]);
    if (result.exitCode !== 0) {
      const error =
        result.stderr.trim() || result.stdout.trim() || "Unknown error";
      return { success: false, error };
    }
    verifyAndRecordSkillHash(name);
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

export async function skillsshSearch(
  query: string,
): Promise<SkillsshSearchResult> {
  // Empty query: use explore (browse trending) instead of search
  if (!query.trim()) {
    return skillsshExplore();
  }

  try {
    const result = await runSkillssh(["search", query, "--limit", "25"]);
    if (result.exitCode !== 0) {
      return { skills: [] };
    }
    // Try JSON first
    try {
      const parsed = JSON.parse(result.stdout);
      if (Array.isArray(parsed)) {
        return {
          skills: parsed.map((s: SkillsshSearchResultItem) => ({
            ...s,
            source: s.source ?? ("skillssh" as const),
          })),
        };
      }
      if (parsed.skills && Array.isArray(parsed.skills)) {
        return {
          skills: parsed.skills.map((s: SkillsshSearchResultItem) => ({
            ...s,
            source: s.source ?? ("skillssh" as const),
          })),
        };
      }
    } catch {
      // CLI outputs text: "slug vVersion  DisplayName  (score)"
    }

    // Parse text output lines: "slug vVersion  Display Name  (score)"
    const skills: SkillsshSearchResultItem[] = [];
    for (const line of result.stdout.split("\n")) {
      const match = line.match(/^(\S+)\s+v(\S+)\s+(.+?)\s+\([\d.]+\)\s*$/);
      if (match) {
        skills.push({
          slug: match[1],
          version: match[2],
          name: match[3].trim(),
          description: "",
          author: "",
          stars: 0,
          installs: 0,
          createdAt: 0,
          source: "skillssh",
        });
      }
    }
    return { skills };
  } catch (err) {
    log.warn({ err }, "skillssh search failed");
    return { skills: [] };
  }
}

export async function skillsshExplore(opts?: {
  limit?: number;
  sort?: string;
}): Promise<SkillsshSearchResult> {
  const limit = String(opts?.limit ?? 25);
  const sort = opts?.sort ?? "installsAllTime";

  try {
    const result = await runSkillssh([
      "explore",
      "--json",
      "--limit",
      limit,
      "--sort",
      sort,
    ]);
    if (result.exitCode !== 0) {
      return { skills: [] };
    }
    try {
      const parsed = JSON.parse(result.stdout);
      const items = parsed.items ?? parsed;
      if (!Array.isArray(items)) return { skills: [] };

      // Normalize explore response to SkillsshSearchResultItem shape
      const skills: SkillsshSearchResultItem[] = items.map(
        (item: Record<string, unknown>) => ({
          name: (item.displayName as string) ?? (item.slug as string) ?? "",
          slug: (item.slug as string) ?? "",
          description: (item.summary as string) ?? "",
          author: (item.author as string) ?? "",
          stars: (item.stats as Record<string, number>)?.stars ?? 0,
          installs:
            (item.stats as Record<string, number>)?.installsAllTime ?? 0,
          version: (item.tags as Record<string, string>)?.latest ?? "",
          createdAt: (item.createdAt as number) ?? 0,
          source: "skillssh",
        }),
      );
      return { skills };
    } catch {
      // parse failure
    }
    return { skills: [] };
  } catch (err) {
    log.warn({ err }, "skillssh explore failed");
    return { skills: [] };
  }
}

export interface SkillsshInspectResult {
  skill: { slug: string; displayName: string; summary: string };
  owner: { handle: string; displayName: string; image?: string } | null;
  stats: {
    stars: number;
    installs: number;
    downloads: number;
    versions: number;
  } | null;
  createdAt: number | null;
  updatedAt: number | null;
  latestVersion: { version: string; changelog?: string } | null;
  files: Array<{ path: string; size: number; contentType?: string }> | null;
  skillMdContent: string | null;
}

export async function skillsshInspect(
  slug: string,
): Promise<{ data?: SkillsshInspectResult; error?: string }> {
  if (!validateSlug(slug)) {
    return { error: `Invalid skill slug: ${slug}` };
  }

  try {
    const result = await runSkillssh([
      "inspect",
      slug,
      "--json",
      "--files",
      "--file",
      "SKILL.md",
    ]);
    if (result.exitCode !== 0) {
      const error =
        result.stderr.trim() || result.stdout.trim() || "Unknown error";
      return { error };
    }
    try {
      const parsed = JSON.parse(result.stdout);
      // Normalize the raw inspect response to our interface
      const data: SkillsshInspectResult = {
        skill: {
          slug: parsed.slug ?? slug,
          displayName: parsed.displayName ?? parsed.name ?? slug,
          summary: parsed.summary ?? parsed.description ?? "",
        },
        owner: parsed.owner
          ? {
              handle: parsed.owner.handle ?? parsed.owner.username ?? "",
              displayName: parsed.owner.displayName ?? parsed.owner.name ?? "",
              image: parsed.owner.image ?? parsed.owner.avatar ?? undefined,
            }
          : null,
        stats: parsed.stats
          ? {
              stars: parsed.stats.stars ?? 0,
              installs:
                parsed.stats.installsAllTime ?? parsed.stats.installs ?? 0,
              downloads:
                parsed.stats.downloadsAllTime ?? parsed.stats.downloads ?? 0,
              versions: parsed.stats.versions ?? 0,
            }
          : null,
        createdAt: parsed.createdAt ?? null,
        updatedAt: parsed.updatedAt ?? null,
        latestVersion: parsed.latestVersion
          ? {
              version: parsed.latestVersion.version ?? "",
              changelog: parsed.latestVersion.changelog ?? undefined,
            }
          : null,
        files: Array.isArray(parsed.files)
          ? parsed.files.map((f: Record<string, unknown>) => ({
              path: (f.path as string) ?? "",
              size: (f.size as number) ?? 0,
              contentType: (f.contentType as string) ?? undefined,
            }))
          : null,
        skillMdContent:
          parsed.skillMdContent ??
          parsed.fileContents?.["SKILL.md"] ??
          parsed.file?.content ??
          null,
      };
      return { data };
    } catch {
      return { error: "Failed to parse inspect output" };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: message };
  }
}

export async function skillsshCheckUpdates(): Promise<
  SkillsshUpdateCheckItem[]
> {
  // This is a placeholder -- skillssh doesn't have a dedicated check-updates command
  // For now return empty; will be implemented when the CLI supports it
  return [];
}

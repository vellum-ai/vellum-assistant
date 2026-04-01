import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getLogger } from "../util/logger.js";
import { getWorkspaceSkillsDir } from "../util/platform.js";
import {
  computeSkillHash,
  readInstallMeta,
  writeInstallMeta,
} from "./install-meta.js";

const log = getLogger("clawhub");

// Managed skills directory — where installed skill folders live
function getManagedSkillsDir(): string {
  return getWorkspaceSkillsDir();
}

// ClaWHub project root — clawhub creates a `skills/` subdir inside its cwd,
// so we use the parent of the managed skills dir as the project root.
function getClawhubProjectRoot(): string {
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

/**
 * Record or verify the content hash of an installed skill.
 * On first install: stores the hash (trust-on-first-use).
 * On subsequent installs: compares with stored hash and warns on mismatch.
 *
 * Reads/writes `contentHash` from `install-meta.json` when available,
 * falling back to the legacy `.integrity.json` manifest for skills that
 * haven't been migrated yet.
 */
export function verifyAndRecordSkillHash(slug: string): void {
  const skillDir = join(getManagedSkillsDir(), slug);
  const hash = computeSkillHash(skillDir);
  if (!hash) {
    log.warn({ slug }, "Could not compute content hash for installed skill");
    return;
  }

  // Try install-meta.json first for stored hash
  const installMeta = readInstallMeta(skillDir);
  let storedHash: string | undefined;

  if (installMeta?.contentHash) {
    storedHash = installMeta.contentHash;
  } else {
    // Fall back to legacy .integrity.json manifest
    const manifest = loadIntegrityManifest();
    const existing = manifest[slug];
    if (existing) {
      storedHash =
        typeof existing.sha256 === "string" ? existing.sha256 : undefined;
    }
  }

  if (storedHash) {
    // Guard against corrupted entries where hash is not a string
    if (typeof storedHash !== "string") {
      log.warn(
        { slug },
        "Stored hash has non-string value — re-recording hash",
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

  // Write to install-meta.json if it exists (preferred), otherwise legacy manifest
  if (installMeta) {
    writeInstallMeta(skillDir, { ...installMeta, contentHash: hash });
  } else {
    const manifest = loadIntegrityManifest();
    manifest[slug] = { sha256: hash, installedAt: new Date().toISOString() };
    saveIntegrityManifest(manifest);
  }
}

interface ClawhubInstallResult {
  success: boolean;
  skillName?: string;
  version?: string;
  error?: string;
}

interface ClawhubSearchResultItem {
  name: string;
  slug: string;
  description: string;
  author: string;
  stars: number;
  installs: number;
  version: string;
  createdAt: number;
  /** Where this skill comes from: "vellum" (first-party) or "clawhub" (community). */
  source: "vellum" | "clawhub";
}

interface ClawhubSearchResult {
  skills: ClawhubSearchResultItem[];
}

interface ClawhubUpdateResult {
  success: boolean;
  updatedVersion?: string;
  error?: string;
}

interface ClawhubUpdateCheckItem {
  name: string;
  installedVersion: string;
  latestVersion: string;
}

// Helper to run clawhub commands
async function runClawhub(
  args: string[],
  opts?: { cwd?: string; timeout?: number },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const cwd = opts?.cwd ?? getClawhubProjectRoot();
  const timeout = opts?.timeout ?? 60000;

  // Ensure managed skills dir exists
  const { mkdirSync } = await import("node:fs");
  mkdirSync(cwd, { recursive: true });

  log.info({ args, cwd }, "Running clawhub command");

  const proc = Bun.spawn(["npx", "clawhub", ...args], {
    cwd,
    env: { ...process.env, CLAWHUB_DISABLE_TELEMETRY: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });

  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<[string, string]>((_, reject) => {
    timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`clawhub command timed out after ${timeout}ms`));
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
    "clawhub command completed",
  );

  return { stdout, stderr, exitCode };
}

export async function clawhubInstall(
  slug: string,
  opts?: { version?: string; contactId?: string },
): Promise<ClawhubInstallResult> {
  if (!validateSlug(slug)) {
    return { success: false, error: `Invalid skill slug: ${slug}` };
  }

  const installSlug = opts?.version ? `${slug}@${opts.version}` : slug;
  const args = ["install", installSlug, "--force"]; // non-interactive

  try {
    const result = await runClawhub(args);
    if (result.exitCode !== 0) {
      const error =
        result.stderr.trim() || result.stdout.trim() || "Unknown error";
      return { success: false, error };
    }

    // Write install-meta.json for the installed skill.
    // contentHash is included here, so there's no need to call
    // verifyAndRecordSkillHash() — it would just rewrite the same data.
    const skillDir = join(getManagedSkillsDir(), slug);
    writeInstallMeta(skillDir, {
      origin: "clawhub",
      slug,
      installedAt: new Date().toISOString(),
      ...(opts?.contactId ? { installedBy: opts.contactId } : {}),
      contentHash: computeSkillHash(skillDir) ?? undefined,
    });

    return { success: true, skillName: slug };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

export async function clawhubUpdate(
  name: string,
): Promise<ClawhubUpdateResult> {
  try {
    const result = await runClawhub(["update", name, "--force"]);
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

export async function clawhubSearch(
  query: string,
  opts?: { limit?: number },
): Promise<ClawhubSearchResult> {
  const limit = opts?.limit ?? 25;

  // Empty query: use explore (browse trending) instead of search
  if (!query.trim()) {
    return clawhubExplore({ limit });
  }

  const result = await runClawhub(["search", query, "--limit", String(limit)]);
  if (result.exitCode !== 0) {
    const error =
      result.stderr.trim() || result.stdout.trim() || "Unknown error";
    throw new Error(`clawhub search failed: ${error}`);
  }
  // Try JSON first
  try {
    const parsed = JSON.parse(result.stdout);
    if (Array.isArray(parsed)) {
      return {
        skills: parsed.map((s: ClawhubSearchResultItem) => ({
          ...s,
          source: s.source ?? ("clawhub" as const),
        })),
      };
    }
    if (parsed.skills && Array.isArray(parsed.skills)) {
      return {
        skills: parsed.skills.map((s: ClawhubSearchResultItem) => ({
          ...s,
          source: s.source ?? ("clawhub" as const),
        })),
      };
    }
  } catch {
    // CLI outputs text: "slug vVersion  DisplayName  (score)"
  }

  // Parse text output lines: "slug vVersion  Display Name  (score)"
  const skills: ClawhubSearchResultItem[] = [];
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
        source: "clawhub",
      });
    }
  }
  return { skills };
}

export async function clawhubExplore(opts?: {
  limit?: number;
  sort?: string;
}): Promise<ClawhubSearchResult> {
  const limit = String(opts?.limit ?? 25);
  const sort = opts?.sort ?? "installsAllTime";

  const result = await runClawhub([
    "explore",
    "--json",
    "--limit",
    limit,
    "--sort",
    sort,
  ]);
  if (result.exitCode !== 0) {
    const error =
      result.stderr.trim() || result.stdout.trim() || "Unknown error";
    throw new Error(`clawhub explore failed: ${error}`);
  }
  try {
    const parsed = JSON.parse(result.stdout);
    const items = parsed.items ?? parsed;
    if (!Array.isArray(items)) return { skills: [] };

    // Normalize explore response to ClawhubSearchResultItem shape
    const skills: ClawhubSearchResultItem[] = items.map(
      (item: Record<string, unknown>) => ({
        name: (item.displayName as string) ?? (item.slug as string) ?? "",
        slug: (item.slug as string) ?? "",
        description: (item.summary as string) ?? "",
        author: (item.author as string) ?? "",
        stars: (item.stats as Record<string, number>)?.stars ?? 0,
        installs: (item.stats as Record<string, number>)?.installsAllTime ?? 0,
        version: (item.tags as Record<string, string>)?.latest ?? "",
        createdAt: (item.createdAt as number) ?? 0,
        source: "clawhub",
      }),
    );
    return { skills };
  } catch {
    throw new Error("Failed to parse clawhub explore output");
  }
}

export interface ClawhubInspectResult {
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

export async function clawhubInspect(
  slug: string,
): Promise<{ data?: ClawhubInspectResult; error?: string }> {
  if (!validateSlug(slug)) {
    return { error: `Invalid skill slug: ${slug}` };
  }

  try {
    const result = await runClawhub([
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
      const data: ClawhubInspectResult = {
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

export async function clawhubCheckUpdates(): Promise<ClawhubUpdateCheckItem[]> {
  // This is a placeholder -- clawhub doesn't have a dedicated check-updates command
  // For now return empty; will be implemented when the CLI supports it
  return [];
}
